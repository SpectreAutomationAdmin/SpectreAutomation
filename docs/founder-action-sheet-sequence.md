# Founder Action Sheet — Sequential — Sprint 2 B4.1

_2026-07-19._

Strict sequential order. Each step names a portal, exact account /
resource name, the recommended region + plan, the exact non-secret
value, the secret env-var name, validation, expected cost, rollback,
and a **"stop and return to Claude"** marker for the code-side work
that must happen between two steps.

Every service is under a Spectre-owned account. Never Silver Springs.

## Cost target

Staging: **≤ USD 40 / month** (all services combined, exclusive of
Microsoft 365 licensing on the user side). Production: separate
sheet at a later phase.

---

## Step 1 — Register the domain

- **Portal**: Cloudflare Registrar (<https://dash.cloudflare.com>).
- **Account**: create or use `spectre-org` — never a personal Cloudflare account tied to Silver Springs.
- **Resource name**: `spectreautomation.com`.
- **Region**: n/a.
- **Plan**: at cost (~USD 10 / year).
- **Non-secret value**: WHOIS privacy ON; auto-renew ON.
- **Secret**: n/a — the domain itself is not a secret.
- **Validation**: `dig spectreautomation.com NS +short` returns Cloudflare nameservers.
- **Cost**: ~USD 10 / year = ~USD 1 / month.
- **Rollback**: Cloudflare Registrar → Manage → transfer out or release.

_No code-side gate. Continue._

---

## Step 2 — Cloudflare DNS zone

- **Portal**: Cloudflare Dashboard.
- **Account**: same Cloudflare account as Step 1.
- **Zone**: `spectreautomation.com` (created automatically when the domain is registered).
- **Records to add now (leave value blank until step 8):**
  - `staging` → CNAME → placeholder (`spectre-staging.fly.dev` once Fly assigns it).
  - `app` → CNAME → placeholder (`spectre-prod.fly.dev`).
  - Proxy status: **DNS only** on both.
- **Non-secret value**: DNS-only mode.
- **Secret**: n/a.
- **Validation**: `dig staging.spectreautomation.com +short` returns the CNAME target after Step 8.
- **Cost**: USD 0.
- **Rollback**: delete the CNAME rows.

**⏸ STOP AND RETURN TO CLAUDE** — before proceeding, confirm you want to keep the two-subdomain split (`staging.` + `app.`). Claude will not proceed with additional Fly / Entra setup until the two subdomains are confirmed.

---

## Step 3 — AWS KMS

- **Portal**: <https://console.aws.amazon.com/kms>.
- **Account**: Spectre AWS org. **Create it under a Spectre-owned email**, never a Silver Springs account.
- **Region**: `us-east-2` (Ohio).
- **Resource name**: `alias/spectre-staging-envelope`.
- **Plan**: pay-as-you-go.
- **Non-secret value**: customer-managed symmetric key; annual rotation ON; usage: encrypt / decrypt / generate data key.
- **Secret env-var names on Fly**:
  - `SPECTRE_KMS_PROVIDER=aws`
  - `SPECTRE_KMS_KEY_ID=alias/spectre-staging-envelope`
  - `SPECTRE_KMS_REGION=us-east-2`
  - `AWS_ACCESS_KEY_ID=<IAM access key id>`
  - `AWS_SECRET_ACCESS_KEY=<IAM access key secret>`
- **IAM policy**: single IAM user `spectre-staging-app` with least-privilege policy granting `kms:Encrypt`, `kms:Decrypt`, `kms:GenerateDataKey`, `kms:DescribeKey` on the key ARN only. **No wildcard.**
- **Validation**: from Fly SSH: `node -e "require('@/lib/kms').selectKmsProvider().then(p => console.log(p.name))"` → prints `aws`.
- **Cost**: ~USD 1 / month (key + minimal ops).
- **Rollback**: `Schedule key deletion` (7-day pending window); delete IAM user + access keys.

**Production hardening path** (see §Certificates and managed identity below): move to Fly-native OIDC → AWS role assumption instead of long-lived access keys.

_No code-side gate. Continue to Step 4._

---

## Step 4 — Neon PostgreSQL

- **Portal**: <https://console.neon.tech>.
- **Account**: `spectre-org` (create if needed).
- **Project name**: `spectre-staging`.
- **Region**: US East (Ohio, `us-east-2`) — match KMS + Fly primary.
- **Plan**: Launch (autoscaling 0.25 → 2 CU).
- **Database name**: `spectre` (default owner `neondb_owner`).
- **Non-secret value**: TLS `sslmode=require`.
- **Secret env-var name on Fly**: `DATABASE_URL` — the `postgresql://…?sslmode=require` string Neon shows once you provision.
- **Validation**: from Fly SSH: `node -e "process.env.DATABASE_URL && console.log('set')"` → `set`.
- **Cost**: USD 19 / month (Launch plan).
- **Rollback**: Neon → project → Delete project.

**⏸ STOP AND RETURN TO CLAUDE** — once `DATABASE_URL` exists, Claude runs the Postgres migration set against the fresh Neon DB. The B4.1 embedded-Postgres validation has already proven the schema + tests are Neon-compatible.

---

## Step 5 — Upstash Redis

- **Portal**: <https://console.upstash.com>.
- **Account**: `spectre-org`.
- **Database name**: `spectre-staging-redis`.
- **Region**: `us-east-1` (Upstash regions differ from Neon).
- **Plan**: Pay-as-you-go (staging fits in the free tier).
- **Non-secret value**: TLS enabled; Upstash exposes `rediss://…`.
- **Secret env-var name on Fly**: `REDIS_URL`.
- **Validation**: from Fly SSH on the worker: `node -e "console.log(process.env.REDIS_URL ? 'set' : 'MISSING')"` → `set`.
- **Cost**: USD 0–5 / month for one connected mailbox.
- **Rollback**: Upstash → database → Delete.

_No code-side gate. Continue to Step 6._

---

## Step 6 — Cloudflare R2 (attachments)

R2 is provisioned now but not written to until Phase C's attachment
lazy-fetch ships. Storing keys in Fly now saves a redeploy later.

- **Portal**: Cloudflare → R2.
- **Bucket name**: `spectre-staging-mailbox-attachments`.
- **Region**: WNAM (Cloudflare default).
- **Plan**: pay-as-you-go.
- **Non-secret value**: no public access; signed URLs only.
- **Secret env-var names on Fly**:
  - `S3_BUCKET=spectre-staging-mailbox-attachments`
  - `S3_ENDPOINT=https://<accountid>.r2.cloudflarestorage.com`
  - `AWS_ACCESS_KEY_ID=<R2 API token access key>`
  - `AWS_SECRET_ACCESS_KEY=<R2 API token secret>`
  - `S3_FORCE_PATH_STYLE=true`
- **Validation**: attempt a HEAD on a signed URL from Fly SSH — returns 200 or 404 (either proves the credentials work).
- **Cost**: USD 0.15 / month for expected volume.
- **Rollback**: R2 → bucket → Empty → Delete; revoke R2 API token.

_No code-side gate. Continue to Step 7._

---

## Step 7 — Fly.io organisation + apps

- **Portal**: <https://fly.io/dashboard>.
- **Organisation slug**: `spectre-org`.
- **Apps to create**:
  1. `spectre-staging` (web) — uses `deploy/fly.web.toml`.
  2. `spectre-staging-worker` — uses `deploy/fly.worker.toml`.
- **Region**: `iad` (US-East) — match KMS + Neon.
- **Plan**: Fly Launch / Basic — 1× shared-cpu-1x machine per app.
- **Non-secret value**: internal port 3000 on web; worker has no HTTP.
- **Secret env-var names**: token used for `flyctl` — save as `FLY_API_TOKEN` if wiring CI later.
- **Validation**:
  - `flyctl status --app spectre-staging` → `status = running`.
  - `flyctl status --app spectre-staging-worker` → `status = running`.
- **Cost**: ~USD 15 / month for both machines (autoscale-to-0 on the worker in staging).
- **Rollback**: `flyctl apps destroy spectre-staging` / `flyctl apps destroy spectre-staging-worker`.

**⏸ STOP AND RETURN TO CLAUDE** — Fly apps exist but have not been deployed yet. Claude sets Fly secrets (`DATABASE_URL`, `REDIS_URL`, AWS keys, R2 keys, KMS config) using `flyctl secrets set …` from the code side. Send Claude the Fly deploy token so the secrets can be pushed without you copying values.

---

## Step 8 — Staging deployment

- **Portal**: Fly.io — but executed by Claude (or CI) using the deploy configs already in the repo.
- **Command**: `flyctl deploy --config deploy/fly.web.toml --app spectre-staging` (then the worker one).
- **Non-secret value**: `release_command = "npx prisma migrate deploy"` runs migrations against Neon BEFORE the new machine promotes.
- **Secret env-var names**: all previously set via `flyctl secrets set`.
- **Validation**: `curl -f https://staging.spectreautomation.com/api/health` → 200.
- **Cost**: included in Step 7.
- **Rollback**: `flyctl releases --app spectre-staging` → pick previous release → `flyctl deploy --image-label <prev>` (or `flyctl scale count 0` to take the app offline while diagnosing).

_No code-side gate. Continue to Step 9._

---

## Step 9 — Microsoft Entra app registration

- **Portal**: <https://entra.microsoft.com> → App registrations → New.
- **Tenant**: Spectre-owned tenant (create a free Entra developer tenant under a `@spectreautomation.com` mailbox once Step 1 is registered).
- **App name**: `Spectre Automation — Delegated Mailbox`.
- **Supported account types**: **Accounts in any organizational directory (Multitenant)** — no personal accounts.
- **API permissions (Delegated)**: exactly the seven approved scopes from [`docs/entra-required-delegated-permissions.md`](entra-required-delegated-permissions.md): `openid`, `profile`, `email`, `offline_access`, `User.Read`, `Mail.Read`, `Mail.Send`. `Mail.Send` was added Sprint 2 Checkpoint 14C-B for reply-from-Work-Intake. No `Mail.ReadWrite`, no `Mail.Send.Shared`, no application permissions. **Do not edit the portal by hand — run [`scripts/entra-sync-delegated-permissions.ps1`](../scripts/entra-sync-delegated-permissions.ps1) instead.**
- **Credentials**: 6-month client secret. Copy the value once, into a secret manager.
- **Secret env-var names on Fly**:
  - `MICROSOFT_GRAPH_DELEGATED_CLIENT_ID=<Application (client) ID>`
  - `MICROSOFT_GRAPH_DELEGATED_CLIENT_SECRET=<client secret value>`
- **Validation**: Founder Action Sheet §6a in the original Entra doc.
- **Cost**: USD 0 (Entra developer tenant is free).
- **Rollback**: delete the app registration (invalidates every secret at once).

**Production hardening path**: certificate-based credential instead of a client secret. Documented in the "Certificates and managed identity" section below.

_No code-side gate. Continue to Step 10._

---

## Step 10 — Staging redirect URI

- **Portal**: Entra → your app → Authentication → Web → Redirect URIs.
- **Value**: `https://staging.spectreautomation.com/api/integrations/microsoft/callback` — exact match.
- **Validation**: from staging, initiate a connect flow. The consent screen loads without an "AADSTS50011: redirect URI mismatch" error.
- **Cost**: USD 0.
- **Rollback**: remove the URI from the Redirect URIs list.

_No code-side gate. Continue to Step 11._

---

## Step 11 — Enable the mailbox feature on staging

- **Portal**: none — invoked with `flyctl secrets set`.
- **Fly secret**: `MAILBOX_INTEGRATION_ENABLED=true` (already the default in `deploy/fly.web.toml`; only change if you had previously flipped it off).
- **Validation**: `https://staging.spectreautomation.com/app/user/settings/connected-accounts` renders the Not-connected state (not a 404).
- **Cost**: USD 0.
- **Rollback**: `flyctl secrets set MAILBOX_INTEGRATION_ENABLED=false` — every mailbox endpoint returns 404 immediately.

_No code-side gate. Continue to Step 12._

---

## Step 12 — Live connection test

Founder logs in with the Silver Springs test mailbox account, clicks
**Connect Outlook** in Settings → Connected accounts, completes
Microsoft consent, and observes:

- The card flips to **Connected — awaiting sync**.
- Within 30–60 seconds the worker imports Inbox messages and the
  card flips to **Connected**.
- Mission Control shows email intake alongside AP + AR.
- Clicking a message opens the detail page with sanitised evidence.
- **Assign to me** / **Resolve** / **Defer** work; activity log
  records each action.
- **Sync now** re-runs; counts advance.
- **Disconnect** flips the card back; a second sync does not run.

This is the B4 acceptance walk from §14 of the founder brief.

**Cost during this step**: ~USD 0.05 (Neon + R2 + KMS activity).

---

## Certificates and managed identity — production hardening path

_Not needed for staging. Documented so we do not carry insecure
patterns forward into production._

### Entra credential

- Staging: 6-month client secret with a calendar reminder to rotate at 5 months (Step 9).
- Production: swap to a **certificate credential** on the Entra app registration. Generate a self-signed X509 cert; upload the public key to Entra; store the private key in AWS KMS. MSAL supports this via `ClientCertificate` — the `@azure/msal-node` `ConfidentialClientApplication` accepts a `clientCertificate` config in place of `clientSecret`. The delegated auth wrapper in `src/lib/integrations/microsoft-graph-delegated.ts` needs a single-line change to read the cert reference from env.

### AWS credentials

- Staging: IAM user with access keys (Step 3).
- Production: **Fly workload identity → AWS role assumption**. Fly issues an OIDC token from `oidc.fly.io`; AWS accepts it via an IAM identity provider; the Fly machine assumes an IAM role with the same least-privilege policy. Zero long-lived AWS credentials in Fly secrets. Requires ~30 minutes of configuration in AWS IAM.

### Rotation policy

- Staging: manual, 6 months for Entra secret; 1 year for AWS keys.
- Production: automatic for AWS (role sessions expire hourly); Entra cert rotation on a 90-day schedule with overlap to allow zero-downtime cutover.

---

## Cost summary

| Step | Service | Monthly cost |
|---|---|---|
| 1 | Cloudflare Registrar | ~$1 |
| 3 | AWS KMS | ~$1 |
| 4 | Neon Launch | $19 |
| 5 | Upstash Redis | $0–5 |
| 6 | Cloudflare R2 | $0.15 |
| 7 | Fly.io 2× shared-cpu | ~$15 |
| **Total staging baseline** | | **~$36–41** |

Production adds a second Fly deployment tier (`app.spectreautomation.com`) plus the Neon + Redis production tiers. Documented separately when the founder authorises production.
