// WI-SYNC-1c (2026-10-18) — source-contract locks for the six
// bidirectional Spectre↔Outlook actions, loop prevention, cursor
// tie-breaker, and financial-preservation guarantees.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const DELETE_SRC = readFileSync(join(process.cwd(), "src/lib/mailbox/delete-message.ts"), "utf8");
const DISMISS_SRC = readFileSync(join(process.cwd(), "src/lib/mailbox/dismiss.ts"), "utf8");
const MATERIALIZER = readFileSync(join(process.cwd(), "src/lib/mailbox/email-materializer.ts"), "utf8");
const SYNC = readFileSync(join(process.cwd(), "src/lib/mailbox/sync.ts"), "utf8");
const RECON = readFileSync(join(process.cwd(), "src/lib/mailbox/reconciliation.ts"), "utf8");
const SCHEMA_PG = readFileSync(join(process.cwd(), "prisma-postgres/schema.prisma"), "utf8");
const MIGRATION_PG = readFileSync(
  join(process.cwd(), "prisma-postgres/migrations/20261018_wi_sync_1c_bidirectional_actions/migration.sql"),
  "utf8",
);
const ROUTE_DELETE = readFileSync(
  join(process.cwd(), "src/app/api/work-intake/[id]/delete-email/route.ts"),
  "utf8",
);
const ROUTE_DISMISS = readFileSync(
  join(process.cwd(), "src/app/api/work-intake/[id]/dismiss/route.ts"),
  "utf8",
);

describe("WI-SYNC-1c · schema + migration", () => {
  it("MailboxConnection carries the composite cursor id column", () => {
    expect(SCHEMA_PG).toMatch(/reconciliationCursorEmailMessageId\s+String\?/);
    expect(MIGRATION_PG).toMatch(/ADD COLUMN "reconciliationCursorEmailMessageId" TEXT/);
  });
  it("WorkIntakeItem gains statusBeforeSuppression + userDismissedAt + userDismissedByUserId", () => {
    expect(SCHEMA_PG).toMatch(/statusBeforeSuppression String\?/);
    expect(SCHEMA_PG).toMatch(/userDismissedAt\s+DateTime\?/);
    expect(SCHEMA_PG).toMatch(/userDismissedByUserId\s+String\?/);
    expect(MIGRATION_PG).toMatch(/"statusBeforeSuppression" TEXT/);
    expect(MIGRATION_PG).toMatch(/"userDismissedAt"\s+TIMESTAMP\(3\)/);
    expect(MIGRATION_PG).toMatch(/"userDismissedByUserId"\s+TEXT/);
  });
  it("OutlookDeleteMutation table + indexes", () => {
    expect(SCHEMA_PG).toMatch(/model OutlookDeleteMutation/);
    expect(MIGRATION_PG).toMatch(/CREATE TABLE "OutlookDeleteMutation"/);
    expect(MIGRATION_PG).toMatch(/OutlookDeleteMutation_mailbox_email_status_idx/);
  });
});

describe("WI-SYNC-1c · delete-message service", () => {
  it("uses the Graph moveMessage endpoint with destinationId=deleteditems", () => {
    expect(DELETE_SRC).toMatch(/const DELETED_ITEMS_DESTINATION = "deleteditems"/);
    expect(DELETE_SRC).toMatch(/provider\.moveMessage\(/);
    expect(DELETE_SRC).toMatch(/destinationId: DELETED_ITEMS_DESTINATION/);
  });
  it("tenant-guards WI and EmailMessage and MailboxConnection before any Graph call", () => {
    for (const check of [
      /link\.workIntakeItem\.clubId !== args\.clubId/,
      /link\.emailMessage\.clubId !== args\.clubId/,
      /mailbox\.clubId !== args\.clubId/,
    ]) {
      expect(DELETE_SRC).toMatch(check);
    }
  });
  it("idempotency early-returns ALREADY_DELETED when softDeletedAt already set", () => {
    expect(DELETE_SRC).toMatch(/if \(link\.emailMessage\.softDeletedAt\) \{/);
    expect(DELETE_SRC).toMatch(/return \{ status: "ALREADY_DELETED" \}/);
  });
  it("persists an OutlookDeleteMutation BEFORE calling Graph", () => {
    const createIdx = DELETE_SRC.indexOf("prisma.outlookDeleteMutation.create");
    const callIdx = DELETE_SRC.indexOf("provider.moveMessage(");
    expect(createIdx).toBeGreaterThan(0);
    expect(callIdx).toBeGreaterThan(createIdx);
  });
  it("on success: flips softDeletedAt + WI SUPPRESSED + saves statusBeforeSuppression + EVIDENCE_DELETED activity (single tx)", () => {
    expect(DELETE_SRC).toMatch(/prisma\.\$transaction\(\[/);
    expect(DELETE_SRC).toMatch(/softDeletedAt: new Date\(\)/);
    expect(DELETE_SRC).toMatch(/status: "SUPPRESSED"/);
    expect(DELETE_SRC).toMatch(/statusBeforeSuppression: workIntakeStatusBefore/);
    expect(DELETE_SRC).toMatch(/action: "EVIDENCE_DELETED"/);
  });
  it("confirms Graph round-trip BEFORE marking success — mutation stays PENDING-shaped if Graph throws", () => {
    expect(DELETE_SRC).toMatch(/status: "RUNNING"/);
    expect(DELETE_SRC).toMatch(/isRetryableGraphError\(/);
    // The failure branch sets status to RETRYABLE or
    // FAILED_TERMINAL via a ternary; match both literals.
    expect(DELETE_SRC).toMatch(/"RETRYABLE"/);
    expect(DELETE_SRC).toMatch(/"FAILED_TERMINAL"/);
  });
  it("writes an audit row on success — action='mailbox.message.delete'", () => {
    expect(DELETE_SRC).toMatch(/action: "mailbox\.message\.delete"/);
  });
  it("never touches APInvoice / JournalEntry / Approval / Payment / ApIntakeSource write surface", () => {
    for (const forbidden of [
      /prisma\.aPInvoice\.(update|delete|create|upsert)/,
      /prisma\.journalEntry\.(update|delete|create|upsert)/,
      /prisma\.approval\.(update|delete|create|upsert)/,
      /prisma\.payment\.(update|delete|create|upsert)/,
      /prisma\.apIntakeSource\.(update|delete|create|upsert)/,
    ]) {
      expect(DELETE_SRC).not.toMatch(forbidden);
    }
  });
});

describe("WI-SYNC-1c · dismiss service", () => {
  it("never calls Microsoft Graph", () => {
    expect(DISMISS_SRC).not.toMatch(/graph\.microsoft\.com/i);
    expect(DISMISS_SRC).not.toMatch(/getMicrosoftDelegatedProvider/);
    expect(DISMISS_SRC).not.toMatch(/moveMessage/);
    expect(DISMISS_SRC).not.toMatch(/markMessageRead/);
  });
  it("tenant-guards + idempotency", () => {
    expect(DISMISS_SRC).toMatch(/wi\.clubId !== args\.clubId/);
    expect(DISMISS_SRC).toMatch(/ALREADY_DISMISSED/);
  });
  it("flips WI → SUPPRESSED + sets userDismissedAt + userDismissedByUserId + writes USER_DISMISSED activity", () => {
    expect(DISMISS_SRC).toMatch(/status: "SUPPRESSED"/);
    expect(DISMISS_SRC).toMatch(/userDismissedAt: now/);
    expect(DISMISS_SRC).toMatch(/userDismissedByUserId: args\.principal\?\.id/);
    expect(DISMISS_SRC).toMatch(/action: "USER_DISMISSED"/);
  });
  it("writes audit — action='work-intake.dismiss'", () => {
    expect(DISMISS_SRC).toMatch(/action: "work-intake\.dismiss"/);
  });
  it("never touches APInvoice / JournalEntry / Approval / Payment / ApIntakeSource write surface", () => {
    for (const forbidden of [
      /prisma\.aPInvoice\./,
      /prisma\.journalEntry\./,
      /prisma\.approval\./,
      /prisma\.payment\./,
      /prisma\.apIntakeSource\./,
    ]) {
      expect(DISMISS_SRC).not.toMatch(forbidden);
    }
  });
});

describe("WI-SYNC-1c · loop prevention + restore", () => {
  it("handleEmailEvidenceDeleted recognizes a SUCCEEDED OutlookDeleteMutation and skips re-suppression", () => {
    expect(MATERIALIZER).toMatch(/prisma\.outlookDeleteMutation\.findFirst/);
    expect(MATERIALIZER).toMatch(/action: "EVIDENCE_DELETE_RECONCILED"/);
    const guardIdx = MATERIALIZER.indexOf("ourDelete");
    const resuppressIdx = MATERIALIZER.indexOf('action: "EVIDENCE_DELETED"');
    expect(guardIdx).toBeGreaterThan(0);
    expect(guardIdx).toBeLessThan(resuppressIdx);
  });
  it("handleEmailEvidenceDeleted saves statusBeforeSuppression on the first evidence-delete", () => {
    expect(MATERIALIZER).toMatch(/statusBeforeSuppression: captureBefore/);
  });
  it("handleEmailEvidenceRestored exists + skips when userDismissedAt is set", () => {
    expect(MATERIALIZER).toMatch(/export async function handleEmailEvidenceRestored/);
    expect(MATERIALIZER).toMatch(/userDismissedAt/);
    expect(MATERIALIZER).toMatch(/EVIDENCE_RESTORED_DISMISSED/);
  });
  it("handleEmailEvidenceRestored only re-activates SUPPRESSED WIs", () => {
    expect(MATERIALIZER).toMatch(/status !== "SUPPRESSED"/);
    expect(MATERIALIZER).toMatch(/EVIDENCE_RESTORED_NOOP/);
  });
  it("handleEmailEvidenceRestored restores to statusBeforeSuppression (default INFORMATIONAL)", () => {
    expect(MATERIALIZER).toMatch(/statusBeforeSuppression\s*\?\?\s*"INFORMATIONAL"/);
    expect(MATERIALIZER).toMatch(/action: "EVIDENCE_RESTORED"/);
  });
  it("sync.ts wires handleEmailEvidenceRestored for softDeleted messages re-entering Inbox", () => {
    expect(SYNC).toMatch(/const isRestore = !!existing\?\.softDeletedAt/);
    expect(SYNC).toMatch(/handleEmailEvidenceRestored\(\s*\{/);
    expect(SYNC).toMatch(/isRestore \? \{ softDeletedAt: null \}/);
  });
});

describe("WI-SYNC-1c · cursor tie-breaker", () => {
  it("reconciliation reads BOTH cursor columns + applies tuple filter", () => {
    expect(RECON).toMatch(/reconciliationCursorReceivedAt: true/);
    expect(RECON).toMatch(/reconciliationCursorEmailMessageId: true/);
    expect(RECON).toMatch(/const cursorFilter/);
    expect(RECON).toMatch(/receivedAt: cursorBefore/);
    expect(RECON).toMatch(/id: \{ lt: cursorBeforeId \}/);
  });
  it("orderBy is [receivedAt desc, id desc] to match the tuple predicate", () => {
    expect(RECON).toMatch(/orderBy:\s*\[\s*\{\s*receivedAt:\s*"desc"\s*\},\s*\{\s*id:\s*"desc"\s*\}\s*\]/);
  });
  it("end-of-run persists BOTH cursor columns", () => {
    expect(RECON).toMatch(/reconciliationCursorEmailMessageId: cursorAfterId/);
    expect(RECON).toMatch(/cursorAfterId = reachedBottom \? null : /);
  });
  it("the cursor filter wraps a receivedAt=cursor AND id<cursorId tuple to catch ties", () => {
    expect(RECON).toMatch(/OR:\s*\[/);
    expect(RECON).toMatch(/receivedAt:\s*\{\s*lt:\s*cursorBefore\s*\}/);
    expect(RECON).toMatch(/AND:\s*\[/);
  });
});

describe("WI-SYNC-1c · admin API routes", () => {
  it("dismiss route guards 401 / 400 / 403 / 404", () => {
    expect(ROUTE_DISMISS).toMatch(/"unauthenticated"/);
    expect(ROUTE_DISMISS).toMatch(/"no_active_club"/);
    expect(ROUTE_DISMISS).toMatch(/"cross_tenant"/);
    expect(ROUTE_DISMISS).toMatch(/"not_found"/);
  });
  it("dismiss route delegates to dismissWorkIntakeItem (no inline logic)", () => {
    expect(ROUTE_DISMISS).toMatch(/dismissWorkIntakeItem\(\{/);
  });
  it("delete-email route guards 401 / 400 / 409 (not applicable) / 502 (graph error)", () => {
    expect(ROUTE_DELETE).toMatch(/"unauthenticated"/);
    expect(ROUTE_DELETE).toMatch(/"no_active_club"/);
    expect(ROUTE_DELETE).toMatch(/status:\s*409/);
    expect(ROUTE_DELETE).toMatch(/status:\s*502/);
  });
  it("delete-email route delegates to deleteOutlookMessageForWorkIntake", () => {
    expect(ROUTE_DELETE).toMatch(/deleteOutlookMessageForWorkIntake\(\{/);
  });
});

describe("WI-SYNC-1c · financial-preservation regression (whole slice)", () => {
  it("no mailbox module writes to AP / journal / approval / payment surfaces", () => {
    for (const src of [DELETE_SRC, DISMISS_SRC, MATERIALIZER, RECON]) {
      for (const forbidden of [
        /prisma\.aPInvoice\.(update|delete|create|upsert)/,
        /prisma\.journalEntry\.(update|delete|create|upsert)/,
        /prisma\.approval\.(update|delete|create|upsert)/,
        /prisma\.payment\.(update|delete|create|upsert)/,
        /prisma\.apIntakeSource\.(update|delete|create|upsert)/,
      ]) {
        expect(src).not.toMatch(forbidden);
      }
    }
  });
});
