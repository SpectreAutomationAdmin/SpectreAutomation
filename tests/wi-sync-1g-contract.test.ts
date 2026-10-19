// WI-SYNC-1g (2026-10-18) — contract test suite for the hardened
// Spectre→Outlook restore flow.  Covers the four invariants the
// founder's directive calls out:
//
//   §1 Inline-flip after Graph confirms + probe verifies.
//   §2 Idempotency across async paths (double-restore is a no-op).
//   §3 User-dismissed WI stays SUPPRESSED on restore.
//   §4 Partial failure records GRAPH_OK_DB_PENDING + recovery
//      completes idempotently.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SRV = readFileSync(
  join(process.cwd(), "src/lib/mailbox/restore-message.ts"),
  "utf8",
);
const ROUTE_RESTORE = readFileSync(
  join(process.cwd(), "src/app/api/work-intake/[id]/restore-email/route.ts"),
  "utf8",
);
const ROUTE_MOVE = readFileSync(
  join(
    process.cwd(),
    "src/app/api/admin/mailbox/debug/move-to-inbox/route.ts",
  ),
  "utf8",
);
const HANDLERS = readFileSync(
  join(process.cwd(), "src/lib/queue/handlers.ts"),
  "utf8",
);
const RECONCILE = readFileSync(
  join(process.cwd(), "src/lib/mailbox/reconciliation.ts"),
  "utf8",
);
const SCHEMA_PG = readFileSync(
  join(process.cwd(), "prisma-postgres/schema.prisma"),
  "utf8",
);
const SCHEMA_DEV = readFileSync(
  join(process.cwd(), "prisma/schema.prisma"),
  "utf8",
);
const MIGRATION_PG = readFileSync(
  join(
    process.cwd(),
    "prisma-postgres/migrations/20261018_wi_sync_1g_restore_mutation/migration.sql",
  ),
  "utf8",
);

describe("WI-SYNC-1g · schema parity", () => {
  it("adds OutlookRestoreMutation to the Postgres schema", () => {
    expect(SCHEMA_PG).toMatch(/model\s+OutlookRestoreMutation\s*\{/);
    expect(SCHEMA_PG).toMatch(/originalGraphMessageId\s+String/);
    expect(SCHEMA_PG).toMatch(/GRAPH_OK_DB_PENDING/);
  });
  it("adds OutlookRestoreMutation to the dev (SQLite) schema", () => {
    expect(SCHEMA_DEV).toMatch(/model\s+OutlookRestoreMutation\s*\{/);
  });
  it("Postgres migration creates the table + three indexes", () => {
    expect(MIGRATION_PG).toMatch(/CREATE TABLE "OutlookRestoreMutation"/);
    expect(MIGRATION_PG).toMatch(/OutlookRestoreMutation_clubId_status_idx/);
    expect(MIGRATION_PG).toMatch(/OutlookRestoreMutation_workIntakeItemId_idx/);
    expect(MIGRATION_PG).toMatch(
      /OutlookRestoreMutation_mailbox_email_status_idx/,
    );
  });
});

describe("WI-SYNC-1g §1 · inline flip after Graph confirms + probe", () => {
  it("records RUNNING mutation BEFORE the Graph call", () => {
    expect(SRV).toMatch(
      /outlookRestoreMutation\.create[\s\S]*?status:\s*"RUNNING"[\s\S]*?provider\.moveMessage/,
    );
  });
  it("calls Graph moveMessage with destinationId=inbox", () => {
    expect(SRV).toMatch(
      /provider\.moveMessage\(\{[\s\S]*?destinationId:\s*INBOX_DESTINATION/,
    );
    expect(SRV).toMatch(/INBOX_DESTINATION\s*=\s*"inbox"/);
  });
  it("verifies destination with probeMessage + inbox well-known folder", () => {
    expect(SRV).toMatch(/provider\.getWellKnownFolder/);
    expect(SRV).toMatch(/wellKnownName:\s*"inbox"/);
    expect(SRV).toMatch(/provider\.probeMessage/);
    expect(SRV).toMatch(/probe\.outcome === "PRESENT"/);
    expect(SRV).toMatch(/probe\.parentFolderId === inboxFolder\.id/);
  });
  it("inline-updates softDeletedAt=null + mutation=SUCCEEDED in a single transaction", () => {
    expect(SRV).toMatch(/prisma\.\$transaction\(\[[\s\S]*?softDeletedAt:\s*null/);
    expect(SRV).toMatch(
      /prisma\.\$transaction\(\[[\s\S]*?outlookRestoreMutation\.update[\s\S]*?status:\s*"SUCCEEDED"/,
    );
  });
  it("calls handleEmailEvidenceRestored after the transaction (not inside it)", () => {
    // The handler starts its own txn; nesting Prisma transactions is a
    // known footgun.  Call must come AFTER the first txn closes.
    const idxTxn = SRV.search(/prisma\.\$transaction\(\[/);
    const idxHandler = SRV.search(/handleEmailEvidenceRestored\(/);
    expect(idxTxn).toBeGreaterThan(0);
    expect(idxHandler).toBeGreaterThan(idxTxn);
  });
});

describe("WI-SYNC-1g §2 · idempotency / loop prevention", () => {
  it("delta sync's isRestore branch is a no-op when softDeletedAt is already null", () => {
    // sync.ts' isRestore = !!existing?.softDeletedAt — if the
    // inline flip cleared it first, the delta's isRestore is false
    // and no duplicate restoration runs.  Keep this invariant
    // locked.
    const SYNC = readFileSync(
      join(process.cwd(), "src/lib/mailbox/sync.ts"),
      "utf8",
    );
    expect(SYNC).toMatch(/const isRestore = !!existing\?\.softDeletedAt/);
  });
  it("completeRestoreMutation short-circuits when mutation is already SUCCEEDED", () => {
    expect(SRV).toMatch(
      /if \(m\.status === "SUCCEEDED"\) return \{ ok: true, detail: "already_succeeded"/,
    );
  });
  it("handleEmailEvidenceRestored is idempotent for already-restored WIs", () => {
    // Pin the shared handler contract — EVIDENCE_RESTORED_NOOP
    // when WI is not SUPPRESSED.  Called in both the inline path
    // and the completion handler.
    const H = readFileSync(
      join(process.cwd(), "src/lib/mailbox/email-materializer.ts"),
      "utf8",
    );
    expect(H).toMatch(/EVIDENCE_RESTORED_NOOP/);
    expect(H).toMatch(/link\.workIntakeItem\.status !== "SUPPRESSED"/);
  });
});

describe("WI-SYNC-1g §3 · user-dismissed WI preserved on restore", () => {
  it("delegates to handleEmailEvidenceRestored (which honours userDismissedAt)", () => {
    // The service MUST call the shared handler, not inline-mutate
    // workIntakeItem.status, so the userDismissedAt branch is
    // reused.
    expect(SRV).toMatch(/handleEmailEvidenceRestored\(/);
    expect(SRV).not.toMatch(/workIntakeItem\.update[\s\S]*?status:\s*"OPEN"/);
    expect(SRV).not.toMatch(/workIntakeItem\.update[\s\S]*?status:\s*"INFORMATIONAL"/);
  });
  it("handler reads userDismissedAt + logs EVIDENCE_RESTORED_DISMISSED NOOP", () => {
    const H = readFileSync(
      join(process.cwd(), "src/lib/mailbox/email-materializer.ts"),
      "utf8",
    );
    expect(H).toMatch(/userDismissedAt:\s*true/);
    expect(H).toMatch(/EVIDENCE_RESTORED_DISMISSED/);
    expect(H).toMatch(/if \(link\.workIntakeItem\.userDismissedAt\)/);
  });
  it("audit log emits userDismissedAtPreserved so the invariant is observable", () => {
    expect(SRV).toMatch(/userDismissedAtPreserved:\s*!!/);
  });
});

describe("WI-SYNC-1g §4 · partial-failure recovery", () => {
  it("catches DB transaction failures and sets GRAPH_OK_DB_PENDING", () => {
    expect(SRV).toMatch(
      /catch\s*\(dbErr\)[\s\S]*?status:\s*"GRAPH_OK_DB_PENDING"/,
    );
  });
  it("enqueues MAILBOX_RESTORE_COMPLETION on the DB-pending path", () => {
    expect(SRV).toMatch(
      /enqueue\(\{[\s\S]*?kind:\s*"MAILBOX_RESTORE_COMPLETION"/,
    );
    expect(SRV).toMatch(
      /idempotencyKey:\s*`mailbox:restore-completion:\$\{mutation\.id\}`/,
    );
  });
  it("returns 202 Accepted (not 200) when GRAPH_OK_DB_PENDING — mismatch is visible", () => {
    expect(ROUTE_RESTORE).toMatch(
      /case "GRAPH_OK_DB_PENDING":\s*return NextResponse\.json\([^)]*,\s*\{\s*status:\s*202\s*\}\s*\)/,
    );
  });
  it("returns 502 on GRAPH_DESTINATION_UNVERIFIED (probe disagrees with move)", () => {
    expect(ROUTE_RESTORE).toMatch(
      /case "GRAPH_DESTINATION_UNVERIFIED":\s*return NextResponse\.json\([^)]*,\s*\{\s*status:\s*502\s*\}\s*\)/,
    );
  });
  it("registers a MAILBOX_RESTORE_COMPLETION handler in queue/handlers.ts", () => {
    expect(HANDLERS).toMatch(
      /registerHandler<\{\s*mutationId:\s*string\s*\}>\(\s*"MAILBOX_RESTORE_COMPLETION"/,
    );
    expect(HANDLERS).toMatch(
      /MAILBOX_RESTORE_COMPLETION:\s*"IMPLEMENTED"/,
    );
  });
  it("reconciliation sweep processes GRAPH_OK_DB_PENDING mutations before probing", () => {
    expect(RECONCILE).toMatch(
      /outlookRestoreMutation\.findMany[\s\S]*?status:\s*"GRAPH_OK_DB_PENDING"/,
    );
    expect(RECONCILE).toMatch(
      /await completeRestoreMutation\(\{\s*mutationId:/,
    );
  });
});

describe("WI-SYNC-1g · endpoint routing", () => {
  it("/api/work-intake/[id]/restore-email delegates to the service", () => {
    expect(ROUTE_RESTORE).toMatch(/restoreOutlookMessageForWorkIntake/);
    expect(ROUTE_RESTORE).not.toMatch(/provider\.moveMessage/);
    expect(ROUTE_RESTORE).not.toMatch(/getFreshDelegatedAccessToken/);
  });
  it("/api/admin/mailbox/debug/move-to-inbox routes softDeleted emails through the service", () => {
    expect(ROUTE_MOVE).toMatch(/if \(email\.softDeletedAt\)/);
    expect(ROUTE_MOVE).toMatch(/restoreOutlookMessageForWorkIntake/);
  });
});

describe("WI-SYNC-1g · financial preservation", () => {
  it("restore service does not touch APInvoice / ApIntakeSource / JournalEntry / Approval / Payment", () => {
    expect(SRV).not.toMatch(/prisma\.aPInvoice\./);
    expect(SRV).not.toMatch(/prisma\.apIntakeSource\./);
    expect(SRV).not.toMatch(/prisma\.journalEntry\./);
    expect(SRV).not.toMatch(/prisma\.approvalRequest\./);
    expect(SRV).not.toMatch(/prisma\.vendorPayment\./);
  });
});
