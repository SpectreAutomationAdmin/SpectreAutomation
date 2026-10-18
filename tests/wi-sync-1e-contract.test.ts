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
  it("WI-SYNC-1e-close §1: six action keys enumerated", () => {
    for (const key of ["mark_read", "mark_unread", "archive", "delete", "dismiss", "restore"]) {
      expect(ROW).toContain(`"${key}"`);
    }
  });
  it("WI-SYNC-1e-close §1: visibility — read/unread toggle + Archive + Delete + Dismiss on active cards; Restore when softDeleted", () => {
    expect(ROW).toMatch(/isActiveEmailBacked/);
    expect(ROW).toMatch(/isSuppressedByDelete/);
    expect(ROW).toMatch(/props\.isRead \? "mark_unread" : "mark_read"/);
    expect(ROW).toMatch(/visible\.push\("archive", "delete", "dismiss"\)/);
    expect(ROW).toMatch(/visible\.push\("restore"\)/);
  });
  it("fires POST against the correct per-action endpoints", () => {
    for (const endpoint of [
      /mark-read-email/,
      /mark-unread-email/,
      /archive-email/,
      /delete-email/,
      /dismiss/,
      /restore-email/,
    ]) {
      expect(ROW).toMatch(endpoint);
    }
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
  it("WI-SYNC-1e-close §1: contextual visibility — Restore is only shown when BOTH SUPPRESSED AND softDeleted", () => {
    expect(ROW).toMatch(/isSuppressedByDelete\s*=[\s\S]*"SUPPRESSED"[\s\S]*isSoftDeleted/);
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

describe("WI-SYNC-1e-close §1 · new user-facing action endpoints", () => {
  const READ_ROUTE = readFileSync(
    join(process.cwd(), "src/app/api/work-intake/[id]/mark-read-email/route.ts"),
    "utf8",
  );
  const UNREAD_ROUTE = readFileSync(
    join(process.cwd(), "src/app/api/work-intake/[id]/mark-unread-email/route.ts"),
    "utf8",
  );
  const ARCHIVE_ROUTE = readFileSync(
    join(process.cwd(), "src/app/api/work-intake/[id]/archive-email/route.ts"),
    "utf8",
  );
  it("mark-read-email: delegates to markReadImpl(wiId, true) + exports markReadImpl", () => {
    expect(READ_ROUTE).toMatch(/markReadImpl\(params\.id, true\)/);
    expect(READ_ROUTE).toMatch(/export async function markReadImpl/);
  });
  it("mark-unread-email: delegates to markReadImpl(wiId, false)", () => {
    expect(UNREAD_ROUTE).toMatch(/markReadImpl\(params\.id, false\)/);
  });
  it("mark-read-email: tenant-guards + idempotency early-return + Graph PATCH + audit", () => {
    expect(READ_ROUTE).toMatch(/link\.workIntakeItem\.clubId !== clubId/);
    expect(READ_ROUTE).toMatch(/mailbox\.clubId !== clubId/);
    expect(READ_ROUTE).toMatch(/alreadyAtTargetState/);
    expect(READ_ROUTE).toMatch(/markMessageRead\(/);
    expect(READ_ROUTE).toMatch(/isRead,/);
    expect(READ_ROUTE).toMatch(/action: isRead \? "mailbox\.message\.mark-read" : "mailbox\.message\.mark-unread"/);
  });
  it("archive-email: writes an OutlookArchiveMutation RUNNING → SUCCEEDED + flips softDeletedAt", () => {
    expect(ARCHIVE_ROUTE).toMatch(/prisma\.outlookArchiveMutation\.create/);
    expect(ARCHIVE_ROUTE).toMatch(/status: "RUNNING"/);
    expect(ARCHIVE_ROUTE).toMatch(/status: "SUCCEEDED"/);
    expect(ARCHIVE_ROUTE).toMatch(/softDeletedAt: new Date\(\)/);
    expect(ARCHIVE_ROUTE).toMatch(/destinationId: ARCHIVE_DESTINATION/);
    expect(ARCHIVE_ROUTE).toMatch(/action: "mailbox\.message\.archive"/);
  });
  it("archive-email: 404 feature-off / 401 unauth / 403 cross-tenant / 409 bad-state / 422 mailbox / 502 graph", () => {
    for (const code of [
      /"mailbox_integration_disabled"/,
      /"unauthenticated"/,
      /"cross_tenant"/,
      /"email_soft_deleted"/,
      /"mailbox_not_connected"/,
      /"graph_error"/,
    ]) {
      expect(ARCHIVE_ROUTE).toMatch(code);
    }
  });
  it("none of the new routes touch AP / journal / approval / payment write surfaces", () => {
    for (const src of [READ_ROUTE, UNREAD_ROUTE, ARCHIVE_ROUTE]) {
      for (const forbidden of [
        /prisma\.aPInvoice\.(update|delete|create|upsert)/,
        /prisma\.journalEntry\.(update|delete|create|upsert)/,
        /prisma\.approval\.(update|delete|create|upsert)/,
        /prisma\.payment\.(update|delete|create|upsert)/,
      ]) {
        expect(src).not.toMatch(forbidden);
      }
    }
  });
});

describe("WI-SYNC-1e-close §2 · staging-only PATCH-renewal endpoint", () => {
  const RENEW = readFileSync(
    join(process.cwd(), "src/app/api/admin/mailbox/debug/force-patch-renewal/route.ts"),
    "utf8",
  );
  it("gated by SPECTRE_ALLOW_STAGING_DEBUG BEFORE session check", () => {
    const gate = RENEW.indexOf("SPECTRE_ALLOW_STAGING_DEBUG");
    const session = RENEW.indexOf("await getCurrentPrincipal(");
    expect(gate).toBeGreaterThan(0);
    expect(gate).toBeLessThan(session);
    expect(RENEW).toMatch(/"debug_endpoint_disabled"/);
  });
  it("fires provider.renewSubscription + persists new expiration + writes audit", () => {
    expect(RENEW).toMatch(/renewSubscription\(/);
    expect(RENEW).toMatch(/prisma\.graphSubscription\.update/);
    expect(RENEW).toMatch(/action: "mailbox\.subscription\.patch-renew"/);
  });
  it("returns oldExpiration + Graph's new expiration + persisted new expiration", () => {
    expect(RENEW).toMatch(/oldExpiration/);
    expect(RENEW).toMatch(/newExpirationFromGraph/);
    expect(RENEW).toMatch(/newExpirationPersisted/);
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
