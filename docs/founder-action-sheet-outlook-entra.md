# Founder Action Sheet — Outlook / Entra live-tenant configuration

_Last updated: 2026-07-23 (Sprint 2 Checkpoint 14C-B — `Mail.Send`
added to the delegated scope list; portal edits are no longer the
approved sync mechanism — use the script in §3 instead)._

This is the checklist for turning on the delegated Outlook integration
against real Microsoft credentials. Every item below requires an
external administrative action — usually the Microsoft Entra admin
center — that Claude cannot complete alone. **Nothing here contains
real secret values, and nothing here should be pasted into chat, PRs,
or committed files.**

Local development already runs against a mocked Microsoft Graph
provider. Sprint 2 B2 is complete WITHOUT any of the steps below.
The steps below unlock B4/C manual acceptance testing against a real
Silver Springs mailbox.

## Prerequisites

- A Spectre-owned Microsoft 365 / Entra tenant exists (or you approve
  creating one under a `spectreautomation.com` primary domain). The
  Entra app registration lives in this tenant. Silver Springs does
  NOT own the Spectre app registration; they are a customer tenant
  that consents to it.
- Domain `spectreautomation.com` is registered and the DNS is on
  Cloudflare. Subdomains `staging.spectreautomation.com` and
  `app.spectreautomation.com` resolve to the deployed infrastructure.

## 1 — Microsoft Entra app registration

**Portal**: <https://entra.microsoft.com> → Applications → App registrations → **New registration**.

**Settings**:

| Field | Value |
|---|---|
| Name | `Spectre Automation — Delegated Mailbox` |
| Supported account types | **Accounts in any organizational directory (Any Microsoft Entra ID tenant — Multitenant)** |
| Redirect URI (Platform: Web) | See §2 below — one per environment |
| Allow public client flows | **No** |

DO NOT tick "Personal Microsoft accounts". The runtime code enforces
this with a Zod-validated `MICROSOFT_GRAPH_AUTHORITY_AUDIENCE` env
that only accepts `"organizations"`, but the identity platform
verifies the choice at authorisation time as well.

After creation, capture:

- **Application (client) ID** — goes into `MICROSOFT_GRAPH_DELEGATED_CLIENT_ID`.
- **Directory (tenant) ID** — the Spectre home tenant. Useful for
  logs, not required at runtime (we accept ANY organizational tenant
  in the audience).

## 2 — Redirect URIs (one entry per environment)

Register EXACTLY these strings in the app's **Authentication →
Web → Redirect URIs** list. Every character matters; Microsoft
performs a byte-exact match.

| Environment | Redirect URI |
|---|---|
| Local dev | `http://localhost:3000/api/integrations/microsoft/callback` |
| Staging   | `https://staging.spectreautomation.com/api/integrations/microsoft/callback` |
| Production| `https://app.spectreautomation.com/api/integrations/microsoft/callback` |

Also register the corresponding logout / front-channel logout URIs
if you want single-sign-out to work later. Phase B does NOT depend
on this.

## 3 — API permissions (delegated only)

**Canonical source of truth:** [`docs/entra-required-delegated-permissions.md`](entra-required-delegated-permissions.md).
It carries the exact `resourceAccess` list (permission GUIDs + Scope
type) that drives the App Registration. **Do not edit the portal by
hand** — the sync script in this section keeps the App Registration
byte-identical to the source-of-truth doc.

**Approved delegated permissions (Microsoft Graph):**

- `openid`
- `profile`
- `email`
- `offline_access`
- `User.Read`
- `Mail.Read`
- `Mail.Send`  ← added Sprint 2 Checkpoint 14C-B for reply-from-Work-Intake

Sprint 2 Checkpoint 14C-B (2026-07-23) added `Mail.Send` so a user
can send a real reply to an inbound conversation from the Mission
Control Work Intake card. `Mail.Send` scopes the token to a single
narrow action:
`POST /me/messages/{id}/reply` — reply on behalf of the connected
user, from the connected user's mailbox. It does NOT grant broad
mailbox mutation (that would require `Mail.ReadWrite`, which is
deliberately still not approved). It does NOT grant sending on
behalf of another user (that would require `Mail.Send.Shared`).

Do NOT add:

- `Mail.ReadWrite` / `Mail.ReadBasic.All` / `Mail.Read.Shared` /
  `Mail.Send.Shared` — every one of these expands the blast radius
  beyond the founder-approved scope of "read the connected user's
  Inbox + reply from the connected user's mailbox". A future
  checkpoint would need to explicitly authorise adding any of them.
- Any **Application** permissions on this app registration. This
  app is delegated-only. The existing tenant-wide `Mail.Send`
  application-permission flow lives on a SEPARATE app registration
  and MUST NOT be co-located here — combining flows would defeat
  the tenant's ability to revoke one without the other.

### 3a — Automated sync (approved mechanism)

Instead of clicking through the portal, run the checked-in sync
script. It reads the source-of-truth doc, translates the scope list
to the Microsoft Graph `applications` PATCH payload, and applies it
via `az rest` — deterministic, replayable, and auditable in shell
history.

**From the repo root (Windows PowerShell):**

```powershell
# 1. Sign in as a Spectre-tenant admin
az login --tenant <SPECTRE_TENANT_ID>

# 2. Sync the delegated permissions on the Spectre App Registration
./scripts/entra-sync-delegated-permissions.ps1 `
    -TenantId  <SPECTRE_TENANT_ID> `
    -ClientId  <SPECTRE_APP_CLIENT_ID>

# 3. Grant admin consent for the Spectre tenant
./scripts/entra-sync-delegated-permissions.ps1 `
    -TenantId  <SPECTRE_TENANT_ID> `
    -ClientId  <SPECTRE_APP_CLIENT_ID> `
    -GrantAdminConsent
```

The script:

- Refuses to run if `APPROVED_DELEGATED_SCOPES` in the code disagrees
  with the source-of-truth doc — the doc is the contract; the code
  and the App Registration MUST match it.
- Prints the desired vs. currently-registered scope diff before
  applying.
- Never writes any secret to shell history.
- Runs read-only in `-WhatIf` mode when you want to review the diff
  without applying.

### 3b — Customer tenants

Customer tenants (e.g. Silver Springs) grant consent per-user during
the connect flow. No admin action is required on the customer side
UNLESS the customer's tenant restricts user consent — in which case
their admin runs the same `-GrantAdminConsent` command against
their tenant id. Every customer tenant that has already consented
under the pre-C14C-B scope list will need to re-consent to pick up
`Mail.Send` — an existing consented mailbox will see
`replyConsent.state = "missing"` in the Mission Control thread API
until it reconnects.

## 4 — Client credentials

Create ONE credential — either a client secret or a certificate.
Recommendation: **client secret with a 6-month expiry** while we
establish the operational rhythm. Move to certificate-based
authentication in a follow-up hardening pass.

**Portal**: **Certificates & secrets → Client secrets → New client secret**.

- Description: `Spectre delegated — <env>`
- Expiry: 6 months
- **Copy the VALUE immediately** — the portal only displays it once.
- Rotate every 5 months and revoke the old value within 24 hours.

The secret value goes into `MICROSOFT_GRAPH_DELEGATED_CLIENT_SECRET`
in the Fly.io secret store — never in `.env` files, never in git,
never in chat.

## 5 — Environment variables to set

All optional at boot; the app runs without them (behind the
feature flag). Set them when you're ready to enable the integration
in that environment.

| Variable | Local dev | Staging / Production |
|---|---|---|
| `MAILBOX_INTEGRATION_ENABLED` | `false` while smoke-testing, then `true` | `true` |
| `APP_URL` | `http://localhost:3000` | `https://staging.spectreautomation.com` or `https://app.spectreautomation.com` |
| `NEXT_PUBLIC_APP_URL` | same as `APP_URL` | same as `APP_URL` (boot-time invariant enforces equality) |
| `MICROSOFT_GRAPH_AUTHORITY_HOST` | leave default (`https://login.microsoftonline.com`) | leave default |
| `MICROSOFT_GRAPH_AUTHORITY_AUDIENCE` | leave default (`organizations`) | leave default |
| `MICROSOFT_GRAPH_DELEGATED_CLIENT_ID` | from §1 | from §1 |
| `MICROSOFT_GRAPH_DELEGATED_CLIENT_SECRET` | from §4 | from §4 |
| `MICROSOFT_GRAPH_REDIRECT_URI` | leave unset — derived from `APP_URL` | leave unset unless a reverse proxy rewrites the path |
| `MICROSOFT_GRAPH_WEBHOOK_URL` | unused in B2 | unused in B2 (C1 sets it up) |
| `MICROSOFT_GRAPH_LIFECYCLE_URL` | unused in B2 | unused in B2 (C1 sets it up) |

## 6 — Validate the app registration

Once §1–§5 are complete you have two ways to smoke-test.

### 6a — UI walk (preferred; introduced in B3)

1. Set `MAILBOX_INTEGRATION_ENABLED=true` in `.env`, restart `npm run dev`.
2. Sign in to Spectre.
3. Open the user menu → **Settings → Connected accounts**, OR paste `/app/user/settings/connected-accounts` directly.
4. The page renders the **Not connected** state with the read-only privacy disclosure and a green **Connect Outlook** button.
5. Click **Connect Outlook** — Spectre redirects to Microsoft's consent page.
6. Sign in with the Silver Springs test mailbox and grant consent.
7. Microsoft returns to `/app/user/settings/connected-accounts?mailbox=connected&cx=<id>` — the page shows a green success banner and the card flips to **Connected — awaiting sync**. The one-time query params are stripped from the URL so refresh doesn't re-fire the banner.
8. A **Disconnect Outlook** button appears. Click it → the confirmation modal appears. Confirm → the card returns to a disconnected/reconnect state.

### 6b — API smoke (headless)

```
# Prereqs: MAILBOX_INTEGRATION_ENABLED=true, dev server running.
curl -X POST http://localhost:3000/api/integrations/microsoft/connect \
     -H "Content-Type: application/json" \
     -H "Cookie: <your Spectre session cookie>" \
     -d '{"returnPath":"/app/user/settings/connected-accounts"}'
```

Expected: `200 OK` with `{"authorizationUrl":"https://login.microsoftonline.com/organizations/oauth2/v2.0/authorize?...", "transactionId": "..."}`.

Follow the URL in a browser, sign in with the Silver Springs test mailbox, complete consent, and land back on `/app/user/settings/connected-accounts?mailbox=connected&cx=...`.

### 6c — Check without printing secrets

Confirm configuration is present without echoing values:

```
# Prints ONLY the presence, not the value
node -e "['MICROSOFT_GRAPH_DELEGATED_CLIENT_ID','MICROSOFT_GRAPH_DELEGATED_CLIENT_SECRET','APP_URL','MAILBOX_INTEGRATION_ENABLED'].forEach(k => console.log(k, process.env[k] ? 'set' : 'MISSING'))"
```

### 6d — Expected DB + audit after success

- `MailboxConnection` — one row for the connecting user, `status = "CONNECTED_PENDING_SYNC"`, `mailboxType = "PERSONAL"`, `accessTokenSecretRef` + `refreshTokenSecretRef` both non-null and starting with `enc:`.
- `MailboxAccess` — one row for the same user, `role = "OWNER"`, `revokedAt = null`.
- `AuditLog` — one `mailbox.connect.initiated` and one `mailbox.connect.completed`; `metaJson` contains the Microsoft tenant id and the connected email, and does NOT contain any token, code, or PKCE value.
- `EncryptedSecretMetadata` — two rows under `scope = "MAILBOX"` (access + refresh secret references).

### 6e — Cleanup after test

- Click **Disconnect Outlook** in the UI, OR `POST /api/integrations/microsoft/disconnect` with `{ "mailboxConnectionId": "<id>" }`.
- Verify `MailboxConnection.status = "DISCONNECTED"`, both token ref columns are `null`, and the two `EncryptedSecretMetadata` rows for this connection have been deleted (explicit secret retirement, per B3 hardening).
- The connecting user can now re-run 6a to reconnect the same mailbox and land in `CONNECTED_PENDING_SYNC` again with a fresh `AuditLog` `mailbox.connect.reconnected` entry.

## 7 — Rotate a client secret

- Create the new secret in the portal (do not delete the old one yet).
- Update `MICROSOFT_GRAPH_DELEGATED_CLIENT_SECRET` in Fly.io.
- Deploy.
- Verify a fresh connect + a token-refresh both succeed against the
  new secret.
- Delete the old secret in the Entra portal.

## 8 — Remove / decommission

If you ever need to shut the integration off entirely:

- In Entra portal: **Delete registration** to invalidate every
  client secret at once.
- Flip `MAILBOX_INTEGRATION_ENABLED=false` in every deployed
  environment. Every `/api/integrations/microsoft/*` route
  immediately returns `404`.
- No further Graph calls will be attempted; existing mailbox rows
  remain readable for evidence retention until you decide separately
  to purge them (a future destructive endpoint, not in Phase B).

## Non-secrets you MAY share with support

- Application (client) ID
- Directory (tenant) ID for the Spectre home tenant
- Redirect URIs
- Requested delegated scopes list

## Never share

- Client secret value
- Any access token, refresh token, id token, authorization code, or
  `code_verifier`
- OAuth `state` values from user sessions
- Contents of `AuditLog.metaJson` for other users' events
