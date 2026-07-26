# Founder Action Sheet — Staging deployment

_Sprint 2 B4 / 2026-07-19._

This is the checklist to stand up `staging.spectreautomation.com` so
the founder can test the complete Outlook flow against a real
Microsoft 365 mailbox — without waiting for Phase C webhooks. Every
item requires an external administrative action Claude cannot
perform alone. Nothing here contains real secret values; nothing
here should be pasted into chat.

## Overview

| Component | Provider | Purpose |
|---|---|---|
| Web + Worker runtime | **Fly.io** | Runs the Next.js app and the background sync worker. |
| Postgres | **Neon** | Primary application database. |
| Redis | **Upstash** | BullMQ queue backend. |
| Object storage | **Cloudflare R2** | Reserved for B4+ attachment lazy-fetch. Not written to until C. |
| DNS + TLS | **Cloudflare** | `staging.spectreautomation.com` A/AAAA + managed TLS. |
| KMS | **AWS KMS** | Envelope key for MAILBOX / API / BILLING scopes. |
| Identity | **Microsoft Entra** | Delegated OAuth for mailbox connect. |

Every service belongs to a Spectre-owned account, never Silver
Springs' or the founder's personal accounts. Once created, transfer
ownership to a shared Spectre organisation.

## 1 — Domain (Cloudflare Registrar)

Portal: <https://dash.cloudflare.com/> → Register a domain →
`spectreautomation.com`.

Exact setting: WHOIS privacy on; auto-renew on.
Value: whatever Cloudflare Registrar shows for the year price.
Owner: Spectre.
Secret name: n/a — the domain itself is not a secret.
Validation: `dig spectreautomation.com NS +short` returns Cloudflare
nameservers.
Removal: Cloudflare Registrar → Manage → transfer or release.

## 2 — Fly.io organisation + apps

Portal: <https://fly.io/dashboard>

- **Organisation**: create `spectre` (or move to an existing one you
  own).
- **Apps**:
  - `spectre-staging` (web) — uses `deploy/fly.web.toml`.
  - `spectre-staging-worker` — uses `deploy/fly.worker.toml`.
- **Billing**: attach a card to the organisation. Staging monthly
  cost target ≤ USD 30.
- **Deployment token**: `flyctl auth token` → save as GitHub Actions
  secret `FLY_API_TOKEN` (secret name matters if you wire CI later).

Validation:

```
flyctl status --app spectre-staging
flyctl status --app spectre-staging-worker
```

Removal:

```
flyctl apps destroy spectre-staging
flyctl apps destroy spectre-staging-worker
```

## 3 — Neon Postgres

Portal: <https://console.neon.tech/>

- **Project**: `spectre-staging`
- **Region**: US East (`us-east-2` / Ohio) — match Fly primary region.
- **Database**: `spectre` (default owner: `neondb_owner`).
- **Compute size**: Autoscaling 0.25 → 2 CU (Launch plan).
- **Connection string**: Neon exposes `postgresql://…?sslmode=require`.

Fly secret name: `DATABASE_URL`.
Set via: `flyctl secrets set DATABASE_URL="postgresql://…" -a spectre-staging`.
Apply the same secret to the worker: `flyctl secrets set DATABASE_URL="postgresql://…" -a spectre-staging-worker`.

Validation:

```
flyctl ssh console -a spectre-staging -C 'node -e "process.env.DATABASE_URL && console.log(\"set\")"'
```

Cleanup: Neon → project → Delete project.

## 4 — Upstash Redis

Portal: <https://console.upstash.com/>

- **Database**: `spectre-staging-redis`
- **Region**: `us-east-1`
- **TLS**: enabled (Upstash exposes `rediss://…`).

Fly secret name: `REDIS_URL`.
Set via: `flyctl secrets set REDIS_URL="rediss://…" -a spectre-staging` and same for worker.

Validation: `flyctl ssh console -a spectre-staging-worker -C 'node -e "console.log(process.env.REDIS_URL ? \"set\" : \"MISSING\")"'`

Cleanup: Upstash → database → Delete.

## 5 — Cloudflare R2 (attachment storage; not written until C)

Portal: Cloudflare → R2.

- **Bucket**: `spectre-staging-mailbox-attachments`
- **Region**: WNAM (Cloudflare default).
- **Access key**: R2 → Manage R2 API tokens → Create. Scope: Object
  Read & Write on the one bucket only.

Fly secrets:
- `S3_BUCKET=spectre-staging-mailbox-attachments`
- `S3_ENDPOINT=https://<accountid>.r2.cloudflarestorage.com`
- `AWS_ACCESS_KEY_ID=<r2 access key id>`
- `AWS_SECRET_ACCESS_KEY=<r2 secret>`
- `S3_FORCE_PATH_STYLE=true`

Set on both apps.

Bucket policy: locked-down defaults. No public access. Signed URL
lifetime capped at 5 minutes (attachment fetch code will set this
explicitly).

Validation: `curl -X HEAD` against a signed URL from the staging
worker's Node REPL returns 200.

Cleanup: R2 → bucket → Empty → Delete. R2 access token → Revoke.

## 6 — Cloudflare DNS

Portal: Cloudflare → `spectreautomation.com` → DNS.

Records:

- `staging` → CNAME → `spectre-staging.fly.dev`, Proxy status: **DNS only** (Fly manages TLS).

Do NOT enable Cloudflare's proxy for the mailbox endpoint — Fly's
managed certificate is on the Fly hostname; the CNAME points at Fly
directly.

Validation:

```
dig staging.spectreautomation.com +short   # → spectre-staging.fly.dev
curl -I https://staging.spectreautomation.com/api/health   # → 200
```

## 7 — AWS KMS

Portal: <https://console.aws.amazon.com/kms>

- **Account**: Spectre AWS org (create if missing).
- **Region**: `us-east-2` (Ohio) — align with Neon.
- **Key**: `alias/spectre-staging-envelope`
  - Customer-managed symmetric.
  - Usage: encrypt / decrypt / generate data key.
  - Enable automatic annual rotation.
- **IAM policy** — least privilege for the Fly runtime user. Grant
  `kms:Encrypt`, `kms:Decrypt`, `kms:GenerateDataKey`,
  `kms:DescribeKey` on the specific key ARN only. No wildcard on
  resource, no `kms:*`.
- **Access from Fly**: create an IAM user
  `spectre-staging-app`, attach the policy, generate access keys.

Fly secrets:
- `SPECTRE_KMS_PROVIDER=aws`
- `SPECTRE_KMS_KEY_ID=alias/spectre-staging-envelope`
- `SPECTRE_KMS_REGION=us-east-2`
- `AWS_ACCESS_KEY_ID=<access key id>` (shared with R2 if IAM user has both; otherwise a separate user is safer)
- `AWS_SECRET_ACCESS_KEY=<secret>`

Validation: `flyctl ssh console -a spectre-staging -C 'node -e "require(\"@/lib/kms\").selectKmsProvider().then(p => console.log(p.name))"'` → prints `aws`.

Cleanup: KMS → Schedule key deletion (7-day pending window). Delete
IAM user access keys. Delete IAM user.

## 8 — Microsoft Entra

(Already documented in [founder-action-sheet-outlook-entra.md](founder-action-sheet-outlook-entra.md); duplicated here for the staging-specific redirect URI.)

Portal: <https://entra.microsoft.com>

- **App registration**: name `Spectre Automation — Delegated Mailbox`
- **Supported account types**: Multitenant (any Entra ID directory,
  no personal accounts).
- **Redirect URI** (Web): add
  `https://staging.spectreautomation.com/api/integrations/microsoft/callback`
  in addition to the localhost and future production entries.
- **API permissions (delegated)**: `openid`, `profile`, `email`,
  `offline_access`, `User.Read`, `Mail.Read`, `Mail.Send`.
  `Mail.Send` was added Sprint 2 Checkpoint 14C-B for reply-from-
  Work-Intake — see the canonical
  [`docs/entra-required-delegated-permissions.md`](entra-required-delegated-permissions.md).
  No `Mail.ReadWrite`, no `Mail.Send.Shared`, no application
  permissions. **Do not click through the portal — run
  [`scripts/entra-sync-delegated-permissions.ps1`](../scripts/entra-sync-delegated-permissions.ps1) instead.**
- **Client credential**: create a 6-month client secret; copy the
  value exactly once.

Fly secrets:
- `MICROSOFT_GRAPH_DELEGATED_CLIENT_ID=<Application (client) ID>`
- `MICROSOFT_GRAPH_DELEGATED_CLIENT_SECRET=<client secret value>`

Validation: `curl -s -X POST https://staging.spectreautomation.com/api/integrations/microsoft/connect` with a real staging session cookie returns a Microsoft consent URL.

## 9 — Deploy commands

Once §§1–8 have real values, the deploy sequence is:

```
# Web
flyctl deploy --config deploy/fly.web.toml --app spectre-staging
# Worker
flyctl deploy --config deploy/fly.worker.toml --app spectre-staging-worker
# Smoke
curl -f https://staging.spectreautomation.com/api/health
```

The `release_command` on the web app runs `prisma migrate deploy`
BEFORE the new machine promotes; a failed migration prevents
traffic from reaching a half-migrated schema.

## 10 — Post-deployment acceptance walk

1. Founder signs in with the Silver Springs test mailbox account
   at `https://staging.spectreautomation.com/login`.
2. Opens Settings → Connected accounts.
3. Clicks **Connect Outlook**.
4. Completes Microsoft consent.
5. Returns to Connected Accounts — status is **Connected — awaiting sync**.
6. Within ~30 seconds of the callback, the background worker picks
   up MAILBOX_INITIAL_SYNC and the status transitions to
   **Connected**. Last-sync time appears.
7. Opens Mission Control — email intake items appear beside AP/AR
   work.
8. Clicks a message from the intake feed. Sanitised email evidence
   renders.
9. Resolves / defers / self-assigns an intake item; a resync does
   not reset the orchestration state.
10. Disconnects Outlook. Token references null. No further sync.

If any step 1–10 fails, capture the browser + Fly worker logs
(sanitised — no tokens) and re-attempt with the founder before
declaring staging accepted.

## 11 — Cleanup after test

If the founder wants to release everything:

- `flyctl apps destroy spectre-staging`
- `flyctl apps destroy spectre-staging-worker`
- Delete Neon project + Upstash Redis + R2 bucket + AWS KMS key +
  IAM users.
- Cloudflare DNS record for `staging` → delete.
- Entra: leave the app registration; it will be reused for
  production. Rotate the client secret if it was written down
  anywhere.

## Non-secrets you MAY share with support

- Fly app names and organisation slug.
- Neon project name + region.
- Upstash database name + region.
- R2 bucket name + endpoint host.
- AWS KMS key alias + region.
- Entra Application (client) ID.
- Cloudflare DNS records (they're already public).

## Never share

- Fly deployment token.
- `DATABASE_URL`, `REDIS_URL`, R2 access keys, AWS secret keys.
- Microsoft client secret.
- Any KMS ciphertext blob or plaintext.
- Any user-facing session cookie captured during smoke testing.
