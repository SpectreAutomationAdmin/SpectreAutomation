# Delegated Microsoft 365 mailbox — Phase 1 complete

_Last updated: 2026-07-24 (Sprint 2 Checkpoint 14D-Closeout)._

The delegated Microsoft 365 mailbox foundation is architecturally
complete for Spectre Phase 1. This document summarises what staging
now supports, which invariants are locked, and where the boundary
of Phase 1 sits.

Development focus shifts from delegated-mailbox infrastructure to
Checkpoint 15A — Operational Intelligence in the next authorized
checkpoint.

## What staging now supports

| Capability | Status | Reference |
|---|---|---|
| Delegated OAuth 2 / OpenID Connect against multi-tenant Entra App | ✅ live | [`docs/entra-required-delegated-permissions.md`](entra-required-delegated-permissions.md), [Checkpoint 12C closeout](#) |
| Encrypted token storage (AWS KMS envelope encryption) | ✅ live | Checkpoint 13A/13B, [`src/lib/kms/`](../src/lib/kms/) |
| Refresh-token rotation + re-encryption on advance | ✅ live | Checkpoint 13E, `MailboxConnection.tokenRevision` |
| Controlled initial mailbox synchronisation | ✅ live | Checkpoint 13F, [`src/lib/mailbox/sync.ts`](../src/lib/mailbox/sync.ts) |
| Deterministic controlled delta synchronisation with cursor | ✅ live | Checkpoint 13G, [`src/lib/mailbox/delta-sync.ts`](../src/lib/mailbox/delta-sync.ts) |
| Conversation-based Work Intake (`mailboxConnectionId + conversationId`) | ✅ live | Checkpoint 14C, [`materialiseEmailIntoConversation`](../src/lib/mailbox/email-materializer.ts) |
| Idempotent duplicate-conversation remediation | ✅ live | Checkpoint 14C, [`remediateDuplicateConversationItems`](../src/lib/mailbox/email-materializer.ts) |
| Inline canonical newest-first thread viewer in Mission Control | ✅ live | Checkpoint 14C, [`InlineConversationPanel`](../src/components/mission-control/InlineConversationPanel.tsx) |
| Deterministic operational analysis pipeline (invoice-shaped) | ✅ live | Checkpoint 14C, [`src/lib/mission-control/invoice-analysis.ts`](../src/lib/mission-control/invoice-analysis.ts) |
| Delegated reply sending via `POST /me/messages/{id}/reply` | ✅ live | Checkpoint 14C-B, [`replyToMessage`](../src/lib/integrations/microsoft-graph-delegated.ts) |
| Deterministic Entra permission synchronisation from source-of-truth doc | ✅ live | Checkpoint 14C-B, [`scripts/entra-sync-delegated-permissions.ps1`](../scripts/entra-sync-delegated-permissions.ps1) |
| Idempotent Azure-CLI-based admin consent workflow | ✅ live | Same script with `-GrantAdminConsent` |
| Tenant-wide `oAuth2PermissionGrant` for approved scopes | ✅ live | Same script |
| Reply-consent detection (grantedScopes vs `APPROVED_DELEGATED_SCOPES`) | ✅ live | Checkpoint 14C, thread API `replyConsent` payload |

## Approved delegated scopes (Phase 1 locked set)

Seven scopes, no more, no less. Any expansion requires an authorised
future checkpoint. See [`docs/entra-required-delegated-permissions.md`](entra-required-delegated-permissions.md) for GUIDs.

- `openid`
- `profile`
- `email`
- `offline_access`
- `User.Read`
- `Mail.Read`
- `Mail.Send`

Explicitly NOT approved in Phase 1: `Mail.ReadWrite`,
`Mail.ReadWrite.Shared`, `Mail.Send.Shared`, `Mail.ReadBasic.All`,
`Mail.Read.Shared`, any `Application` permission on this app
registration, `Files.Read.All` or any other Graph resource.

## Phase 1 behavioural invariants (locked by tests)

- **Tenant isolation**: no cross-club read or write.
- **Personal mailbox visibility**: PERSONAL mailboxes readable only
  by their connecting user. Club Admin does not bypass.
- **Fail-closed on missing consent**: reply endpoint refuses
  server-side when the mailbox's stored `grantedScopes` does not
  include `Mail.Send` — even if the client bypasses UI gating.
- **Fail-closed on missing configuration**: worker refuses to boot
  when a controlled-mode subordinate env is set without the master
  switch.
- **Server-side reply target**: client cannot supply
  `graphMessageId`, `to`, `cc`, `subject`, or `mailboxConnectionId`
  on the reply endpoint. Every routing decision is derived from the
  authorised WorkIntakeItem's PRIMARY origin.
- **Idempotency**: reply endpoint honours `x-idempotency-key`;
  duplicate submits within 24 h return 409 with the prior send's
  result.
- **Audit without body**: `REPLY_SENT` and every other mailbox
  activity records structured metadata (sender mailbox, idempotency
  key) but NEVER the body content.
- **No autonomous send**: no path in the codebase sends a reply
  without an explicit `POST /api/mission-control/work-intake/[id]/reply`
  triggered by an interactive user action + confirmation.
- **No auto-resolve**: successful reply does NOT change the Work
  Intake item's status. Users decide orchestration.
- **Conversation grouping**: one Microsoft conversation ↔ one
  `WorkIntakeItem`. Multiple messages in the same conversation link
  to the same intake via multiple `PRIMARY`
  `EmailWorkIntakeOrigin` rows.
- **Deterministic sanitisation**: every email body renders through
  `sanitizeEmailHtml` before persistence; the browser only ever
  sees the sanitised output; remote images neutralised to
  `about:blank`; links forced to `rel="noopener noreferrer nofollow"
  target="_blank"` with allowed URL schemes limited to
  `http/https/mailto/tel`.

## Phase 1 boundary — deferred to a later phase

The following are explicitly OUT of Phase 1 and require a new
founder-authorised checkpoint:

- Recurring / continuous mailbox synchronisation
- Microsoft Graph webhooks / subscriptions
- Attachment byte retrieval
- Sent-Items folder synchronisation (see "Known limitations" below)
- Shared-mailbox support
- Cross-mailbox / cross-tenant conversation stitching
- HTML reply composition
- Reply with attachments
- Marking mail read / moving / deleting
- Autonomous reply generation (AI drafts)
- Autonomous send
- AP-draft auto-creation from email evidence
- Silver Springs (or any customer) mailbox connection
- Production deployment

## Known limitations (Phase 1)

- **Sent messages are not visible via Inbox delta.** The delegated
  provider reads exclusively from
  `/me/mailFolders/inbox/messages/delta`. When a user replies from
  Mission Control, the sent message lands in the user's Sent Items
  folder in Microsoft and is invisible to our Inbox-only reader.
  The source message's `isRead` and `conversationIndex` update, which
  our next controlled delta correctly detects — but the sent
  message itself does not thread into our stored conversation until
  a future checkpoint adds Sent Items folder support. Verified
  behaviour in Checkpoint 14D-Closeout Phase C: after a real reply,
  the delta returned the source message as UPDATED (isRead flipped
  false → true) with 0 messagesImported, exactly as expected.
- **Attachment fetches are metadata-only.** `hasAttachments` is
  persisted, but attachment bytes are never downloaded. The UI
  notes the presence of an attachment without a preview or
  download path.
- **Delta-cursor loss requires an authorised re-run.** If Microsoft
  invalidates the cursor (>30-day inactivity, security roll), the
  next controlled delta will return a 410 Gone. Re-establishing the
  cursor requires an authorised initial-sync run.
- **Existing consented mailboxes need to reconsent when the scope
  list changes.** Every scope-list update triggers this. The Mission
  Control card surfaces a plain-language "reconnect the mailbox to
  approve the additional scope" banner and the reply endpoint
  refuses the send. Only reconnecting the mailbox (with a fresh
  OAuth flow) upgrades an existing connection.

## Runbook — safe operational actions

- **Change the approved scope list**: edit
  [`docs/entra-required-delegated-permissions.md`](entra-required-delegated-permissions.md),
  then edit `APPROVED_DELEGATED_SCOPES` in the code to match, then
  run
  [`scripts/entra-sync-delegated-permissions.ps1`](../scripts/entra-sync-delegated-permissions.ps1)
  with `-WhatIf` and finally without. The script refuses to run if
  the doc and code disagree.
- **Grant/refresh admin consent**: rerun the same script with
  `-GrantAdminConsent`. Idempotent.
- **Rotate the delegated client secret**: [Founder Action Sheet §7](founder-action-sheet-outlook-entra.md).
- **Restore worker to cold state**: `flyctl secrets set MAILBOX_INTEGRATION_ENABLED=false --app spectre-staging-worker`.
- **Disconnect a mailbox**: user clicks Disconnect in Settings →
  Connected Accounts, OR admin `POST /api/integrations/microsoft/disconnect`.
