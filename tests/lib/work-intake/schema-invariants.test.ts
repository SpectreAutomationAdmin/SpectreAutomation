// Sprint 2 (2026-07-19) — Schema invariant tests.
//
// The Prisma schema was edited by hand and the additive migration
// generated via `prisma migrate diff`. This test asserts that the
// generated migration contains the specific constraints and indexes
// the founder's Phase B directive requires. A regression that
// silently drops one of these would be very expensive to catch
// otherwise — the schema is 8700 lines.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const MIGRATION_SQL = readFileSync(
  join(process.cwd(), "prisma/migrations/20260719000000_mailbox_integration/migration.sql"),
  "utf8",
);

describe("mailbox-integration migration — required tables and constraints", () => {
  it("creates all eight new tables", () => {
    for (const table of [
      "WorkIntakeItem",
      "WorkIntakeActivity",
      "EmailWorkIntakeOrigin",
      "MailboxConnection",
      "MailboxAccess",
      "GraphSubscription",
      "EmailMessage",
      "EmailAttachment",
    ]) {
      expect(MIGRATION_SQL).toMatch(new RegExp(`CREATE TABLE "${table}"`));
    }
  });

  it("does NOT modify any existing table", () => {
    // The migration must be additive. If a stray ALTER TABLE lands
    // for something like User or Club, this test fires and forces a
    // review before deployment.
    const alters = MIGRATION_SQL.match(/ALTER TABLE "[^"]+"/g) ?? [];
    // Prisma emits ALTER TABLE only for foreign keys on the NEW tables
    // via CREATE TABLE ... CONSTRAINT syntax — no bare ALTERs allowed.
    expect(alters, `Unexpected ALTER TABLE statements: ${alters.join(", ")}`).toEqual([]);
  });

  it("MailboxConnection stores tokens as KMS secret references, not plaintext", () => {
    // Confirms we did not accidentally introduce plaintext token
    // columns. The columns MUST be named *SecretRef.
    expect(MIGRATION_SQL).toMatch(/"accessTokenSecretRef" TEXT NOT NULL/);
    expect(MIGRATION_SQL).toMatch(/"refreshTokenSecretRef" TEXT NOT NULL/);
    expect(MIGRATION_SQL).not.toMatch(/"accessToken" TEXT/);
    expect(MIGRATION_SQL).not.toMatch(/"refreshToken" TEXT/);
  });

  it("GraphSubscription stores clientState as a KMS secret reference", () => {
    expect(MIGRATION_SQL).toMatch(/"clientStateSecretRef" TEXT NOT NULL/);
    expect(MIGRATION_SQL).not.toMatch(/"clientState" TEXT NOT NULL/);
  });

  it("MailboxConnection has @@unique([userId, clubId, provider, externalUserId])", () => {
    // Enforces "a given user cannot connect the same external mailbox
    // twice within the same club" — the callback idempotency guard.
    expect(MIGRATION_SQL).toMatch(
      /CREATE UNIQUE INDEX "MailboxConnection_userId_clubId_provider_externalUserId_key"/,
    );
  });

  it("EmailMessage has @@unique([mailboxConnectionId, graphMessageId])", () => {
    // Enforces "ingest is idempotent on (mailboxConnectionId,
    // graphMessageId)" — the delta-sync idempotency guard.
    expect(MIGRATION_SQL).toMatch(
      /CREATE UNIQUE INDEX "EmailMessage_mailboxConnectionId_graphMessageId_key"/,
    );
  });

  it("EmailAttachment has @@unique([emailMessageId, graphAttachmentId])", () => {
    expect(MIGRATION_SQL).toMatch(
      /CREATE UNIQUE INDEX "EmailAttachment_emailMessageId_graphAttachmentId_key"/,
    );
  });

  it("EmailWorkIntakeOrigin has @@unique([workIntakeItemId, emailMessageId])", () => {
    // Prevents duplicate email→intake links; the materialiser's
    // PRIMARY-role guard is the app-side complement.
    expect(MIGRATION_SQL).toMatch(
      /CREATE UNIQUE INDEX "EmailWorkIntakeOrigin_workIntakeItemId_emailMessageId_key"/,
    );
  });

  it("MailboxAccess has @@unique([mailboxConnectionId, userId, role])", () => {
    expect(MIGRATION_SQL).toMatch(
      /CREATE UNIQUE INDEX "MailboxAccess_mailboxConnectionId_userId_role_key"/,
    );
  });

  it("GraphSubscription has @@unique on microsoftSubscriptionId", () => {
    expect(MIGRATION_SQL).toMatch(
      /CREATE UNIQUE INDEX "GraphSubscription_microsoftSubscriptionId_key"/,
    );
  });

  it("every new table carries clubId or reaches it via a FK", () => {
    // Direct-tenancy tables:
    for (const t of ["WorkIntakeItem", "MailboxConnection", "EmailMessage", "EmailWorkIntakeOrigin"]) {
      expect(MIGRATION_SQL).toMatch(new RegExp(`CREATE TABLE "${t}"[\\s\\S]*?"clubId" TEXT NOT NULL`));
    }
    // Reached-via-FK tables — they never carry clubId directly but
    // point at a parent that does. These MUST be filtered through
    // the parent in every read; verified in tenant.test.ts.
    for (const t of ["WorkIntakeActivity", "MailboxAccess", "GraphSubscription", "EmailAttachment"]) {
      expect(MIGRATION_SQL).toMatch(new RegExp(`CREATE TABLE "${t}"[\\s\\S]*?FOREIGN KEY`));
    }
  });

  it("WorkIntakeItem has the Mission Control read index", () => {
    expect(MIGRATION_SQL).toMatch(
      /CREATE INDEX "WorkIntakeItem_clubId_status_displayReceivedAt_idx"/,
    );
  });

  it("GraphSubscription has a renewal-scan index on expirationDateTime", () => {
    // The reconciliation heartbeat scans this index every 15 minutes
    // for subscriptions expiring within 6 hours. Without the index
    // the heartbeat becomes a table scan.
    expect(MIGRATION_SQL).toMatch(
      /CREATE INDEX "GraphSubscription_expirationDateTime_idx"/,
    );
  });
});

describe("mailbox-integration migration — no stray SERVICE mailboxType", () => {
  it("MailboxConnection defaults to PERSONAL and never mentions SERVICE", () => {
    // Founder rejected SERVICE from the enum in Phase B. Guard
    // against a future refactor that quietly reintroduces it.
    expect(MIGRATION_SQL).toMatch(/"mailboxType" TEXT NOT NULL DEFAULT 'PERSONAL'/);
    expect(MIGRATION_SQL).not.toMatch(/SERVICE/);
  });
});
