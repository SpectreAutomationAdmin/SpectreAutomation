# Entra App Registration — required delegated permissions (source of truth)

_Last updated: 2026-07-23 (Sprint 2 Checkpoint 14C-B)._

This document is the **single source of truth** for the delegated
Microsoft Graph permissions granted to the Spectre `Spectre Automation
— Delegated Mailbox` App Registration. Changes to this file:

1. MUST be reflected in `APPROVED_DELEGATED_SCOPES` at
   [`src/lib/integrations/microsoft-graph-delegated.ts`](../src/lib/integrations/microsoft-graph-delegated.ts).
2. MUST be applied to the live App Registration via
   [`scripts/entra-sync-delegated-permissions.ps1`](../scripts/entra-sync-delegated-permissions.ps1).
   The script refuses to run if this file and the code array disagree.
3. MUST NOT be made via a one-off portal edit. Portal drift is treated
   as a defect — re-run the sync script to correct it.

## Approved delegated permissions

The Microsoft Graph resource id is stable at
`00000003-0000-0000-c000-000000000000`. Permission ids are the
canonical GUIDs Microsoft publishes for each `Scope`-type delegated
permission (documented at
<https://learn.microsoft.com/en-us/graph/permissions-reference>).
Do NOT change these GUIDs — they identify the permission, not our
copy of it.

| Scope name       | Permission id (GUID)                     | Type    | Since |
|------------------|------------------------------------------|---------|-------|
| `openid`         | `37f7f235-527c-4136-accd-4a02d197296e`   | Scope   | B2    |
| `profile`        | `14dad69e-099b-42c9-810b-d002981feec1`   | Scope   | B2    |
| `email`          | `64a6cdd6-aab1-4aaf-94b8-3cc8405e90d0`   | Scope   | B2    |
| `offline_access` | `7427e0e9-2fba-42fe-b0c0-848c9e6a8182`   | Scope   | B2    |
| `User.Read`      | `e1fe6dd8-ba31-4d61-89e7-88639da4683d`   | Scope   | B2    |
| `Mail.Read`      | `570282fd-fa5c-430d-a7fd-fc8dc98a9dca`   | Scope   | B2    |
| `Mail.Send`      | `e383f46e-2787-4529-855e-0e479a3ffac0`   | Scope   | 14C-B |

## Rationale — what each scope enables and does NOT enable

- `openid` + `profile` + `email` — issue an id_token that identifies
  the connected user. Nothing else.
- `offline_access` — issue a refresh token so the delegated flow can
  survive access-token expiry without re-prompting the user.
- `User.Read` — read the connected user's own profile (used by
  `/me` at OAuth completion to persist the connected email).
- `Mail.Read` — read messages in the connected user's mailbox. Used
  for Inbox initial + delta synchronization. Does NOT allow marking
  messages read, moving them, or deleting them.
- `Mail.Send` (added 14C-B) — call `POST /me/messages/{id}/reply`
  as the connected user to send a reply into an existing conversation
  from the user's own mailbox. Does NOT allow constructing arbitrary
  outbound messages (Microsoft derives recipients + subject from the
  source message server-side); does NOT allow modifying the source
  message; does NOT allow sending from another mailbox.

## Explicitly NOT approved

Adding any of these expands the blast radius beyond the founder's
current approval. Each requires a new founder-authorized checkpoint
before being added:

| Scope name              | Why it is NOT approved |
|-------------------------|------------------------|
| `Mail.ReadWrite`        | Would let Spectre mark, move, and delete messages in the user's mailbox. Never needed for read + reply. |
| `Mail.ReadWrite.Shared` | Cross-mailbox mutation. Shared-mailbox work happens in a later phase. |
| `Mail.Send.Shared`      | Sending as another user. Never authorized. |
| `Mail.ReadBasic.All`    | Tenant-wide read. Never authorized. |
| Any `Application` role  | This App Registration is delegated-only. The existing tenant-notification `Mail.Send` (application permission) lives on a SEPARATE app registration and MUST NOT be co-located here. |
| `Files.Read.All` / any other Graph resource | Out of scope for the mailbox feature. |

## Consent behavior

- **Spectre home tenant** — a Spectre-tenant admin runs the sync
  script with `-GrantAdminConsent` to grant admin consent for the
  entire tenant.
- **Customer tenants** (e.g. Silver Springs) — consent happens
  per-user during the connect flow. If the tenant has restricted
  user consent, the customer's admin runs the sync script against
  their own tenant id to grant admin consent for their users.
- **Existing consented mailboxes from before a new scope was added**
  (like Mail.Send arriving in 14C-B against a mailbox consented under
  the 6-scope 14C-A list) — Spectre's runtime detects the missing
  scope from `MailboxConnection.grantedScopes` and refuses to attempt
  any Graph operation that would need it. The Mission Control reply
  composer displays a plain-language "reconnect the mailbox to
  approve the additional scope" notice. Users reconnect via
  Settings → Connected accounts.

## Automated verification

Run:

```
npm test -- tests/entra-required-permissions.test.ts
```

The test compares this file's scope table to
`APPROVED_DELEGATED_SCOPES` in the code. Any drift fails the test.

## Runbook — apply a scope change

1. Update the table above.
2. Update `APPROVED_DELEGATED_SCOPES` in the code to match.
3. Run the automated verification test — it must pass.
4. Run the sync script with `-WhatIf` — review the diff.
5. Run the sync script (without `-WhatIf`) — applies to the live App Registration.
6. Run the sync script with `-GrantAdminConsent` — grants admin consent for the Spectre tenant.
7. Notify affected customer tenants that they may need to reconsent — existing tokens issued under the previous scope list will not be automatically upgraded.
