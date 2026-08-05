-- Sprint 3 · Checkpoint 16H remediation (2026-08-05) — server-side
-- identity lock for OAuth re-consent flows. Callback validates the
-- returned Microsoft oid + tid against these fields before touching
-- tokens. login_hint on the authorization URL is an identity-selection
-- aid; the server-side comparison is authoritative.

ALTER TABLE "MailboxOAuthTransaction" ADD COLUMN "expectedMailboxConnectionId" TEXT;
ALTER TABLE "MailboxOAuthTransaction" ADD COLUMN "expectedExternalUserId" TEXT;
ALTER TABLE "MailboxOAuthTransaction" ADD COLUMN "expectedExternalTenantId" TEXT;
