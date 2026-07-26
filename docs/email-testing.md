# POS receipt email — local testing

This document covers how to verify, locally, that a real receipt email is
delivered when a Lounge POS check is settled. The same delivery pipeline is
used in production once SMTP or SES credentials are configured.

## Quick start (local)

1. **Start the local SMTP sink**

   ```
   npm run mail:dev
   ```

   Runs Maildev: SMTP on `localhost:1025`, web inbox at <http://localhost:8025>.

2. **Make sure `.env.local` selects SMTP** — the file is gitignored; values are:

   ```
   EMAIL_DELIVERY_MODE=smtp
   SMTP_HOST=localhost
   SMTP_PORT=1025
   SMTP_FROM=receipts@silver.club
   SMTP_SECURE=false
   ```

   `SMTP_USER` / `SMTP_PASS` stay unset — Maildev accepts anonymous senders.

3. **Restart the dev server** so the new env is picked up:

   ```
   npm run dev
   ```

4. **Run a Lounge POS check end-to-end** — open <http://localhost:3000/app/admin/ops/pos/lounge>,
   pick a member with a real email on their profile, add items, settle by
   "Charge to Member Account" or "Settle by Phone (QR)". The success card
   reads *"Receipt emailed to c***@gmail.com"* and the email appears in the
   Maildev web inbox.

5. **For the scripted version** (creates checks via the service layer and
   asserts the inbox receives them):

   ```
   npm run email:test-pos-receipt
   ```

   Defaults to Owen Beauchamp at Silver Springs — override with
   `TEST_MEMBER_FIRST=...` / `TEST_MEMBER_LAST=...`. Exits 0 on full pass.

## What the verification script asserts

- `EMAIL_DELIVERY_MODE=smtp` is set and `SMTP_HOST`/`SMTP_PORT`/`SMTP_FROM` are
  configured.
- A TCP probe reaches `SMTP_HOST:SMTP_PORT` (catches "you forgot to start
  Maildev").
- A MEMBER_ACCOUNT settlement records `POSCheck.receiptEmailStatus="SENT"`
  AND the email lands in the Maildev inbox.
- A QR_PAY settlement does NOT email while pending; only after
  `confirmQRPayment` does the inbox receive a receipt with status `SENT`.
- A QR_PAY decline leaves the check in `PAYMENT_FAILED` with no inbox entry.
- `EmailDeliveryEvent` rows are written with `kind=POS_RECEIPT_SENT` and
  `provider=smtp` (audit trail beyond the per-check status).

## Where the email comes from

- **Subject:** `Your {Club} receipt — {SaleNumber}`
- **From:** `SMTP_FROM` env var (or the per-club override).
- **Body:** itemized lines (with any modifiers), subtotal, every tax line
  (e.g. GST), grand total, payment method, and an absolute link back to the
  member's dining receipt page.

## Modes

`EMAIL_DELIVERY_MODE` and the per-club `IntegrationSetting(scope=EMAIL)` row
together pick the adapter, in this order:

1. Per-club `IntegrationSetting` with `provider="ses"` → SES adapter.
2. Per-club `IntegrationSetting` with `provider="smtp"` → SMTP adapter (uses the
   row's config + secret store).
3. Per-club row with `provider="dev"` or `"local"` → treated as **placeholder**:
   the seed creates one of these for every club, so the env-driven mode below
   takes effect. Without that override-of-the-override, a freshly seeded club
   would silently stay on console.
4. `EMAIL_DELIVERY_MODE=smtp` env → SMTP via env vars (`SMTP_HOST`, etc.).
5. `EMAIL_DELIVERY_MODE=ses` env → SES; per-club credentials required
   (env-only SES is not supported because credentials shouldn't sit in env).
6. Nothing set → `console` mode. The adapter logs `[dev:email] → recipient | subject`
   to stdout and records `POSCheck.receiptEmailStatus="DEV_LOGGED"`. The UI
   says "Receipt generated in the development email log" rather than claiming
   real delivery.

## Real provider setup

> **Sender-domain verification is non-negotiable.** Every provider below
> requires `SMTP_FROM`'s domain (the part after `@`) to be verified
> with the provider via DNS records (SPF + DKIM at minimum). An
> unverified sender either fails outright or lands in spam.

Replace placeholder values with your real credentials. Put them in
`.env.local` (gitignored), never in `.env`. Restart the dev server
after editing. Verify with:

```
npm run email:test-real -- you@yourinbox.com
```

That script handshakes with the SMTP server before sending, prints a
clear "LOCAL vs EXTERNAL" classification, and only reports success if
the provider accepts the message.

### Postmark SMTP

1. Create a "Server" in Postmark.
2. Copy the **Server API Token** — it's used as BOTH `SMTP_USER` and
   `SMTP_PASS`. (Postmark's SMTP auth is symmetric.)
3. Verify your sender domain under *Sender Signatures*.

```
EMAIL_DELIVERY_MODE=smtp
SMTP_HOST=smtp.postmarkapp.com
SMTP_PORT=587
SMTP_USER=<server-token>
SMTP_PASS=<server-token>
SMTP_FROM="Silver Springs Receipts <receipts@yourverifieddomain.com>"
SMTP_SECURE=false
```

### SendGrid SMTP

1. *Settings → API Keys* → create a key with **Mail Send** scope.
2. SendGrid's SMTP user is the literal string `apikey`; the password is
   the API key value.
3. Verify your sender via Single Sender or Domain Authentication.

```
EMAIL_DELIVERY_MODE=smtp
SMTP_HOST=smtp.sendgrid.net
SMTP_PORT=587
SMTP_USER=apikey
SMTP_PASS=SG.xxxxxxxx
SMTP_FROM="Silver Springs Receipts <receipts@yourverifieddomain.com>"
SMTP_SECURE=false
```

### Amazon SES SMTP

SES has a REST API and an SMTP interface — we use SMTP here so the same
adapter works for all providers. The SMTP credentials are NOT your IAM
access keys; you generate them in the SES console.

1. *AWS Console → SES → SMTP settings → Create SMTP credentials.*
2. The wizard creates an IAM user with `ses:SendRawEmail` and gives you a
   distinct `SMTP_USER` (≠ access key id) and `SMTP_PASS`.
3. Verify the sender identity under *Verified identities*. New
   accounts are sandboxed — request production access for non-verified
   recipients.
4. The host is region-scoped: `email-smtp.<region>.amazonaws.com`.

```
EMAIL_DELIVERY_MODE=smtp
SMTP_HOST=email-smtp.us-east-1.amazonaws.com
SMTP_PORT=587
SMTP_USER=<SES-SMTP-username>
SMTP_PASS=<SES-SMTP-password>
SMTP_FROM=receipts@yourverifieddomain.com
SMTP_SECURE=false
```

### Gmail SMTP (development only)

Google blocks plain-password SMTP. You need a 16-char **App Password**
on a Google account with 2-factor auth enabled. Daily send limits
(~500/day for free accounts) and Gmail's anti-spam heuristics make
this unsuitable for production receipts. Use it only to confirm
end-to-end delivery to your own personal inbox while developing.

1. *Google Account → Security → 2-Step Verification* (must be on).
2. *App passwords* → create one for "Mail / Other (Spectre)".
3. Use the 16-char value as `SMTP_PASS`.

```
EMAIL_DELIVERY_MODE=smtp
SMTP_HOST=smtp.gmail.com
SMTP_PORT=587
SMTP_USER=you@gmail.com
SMTP_PASS=<16-char app password>
SMTP_FROM=you@gmail.com       # MUST match the Gmail account
SMTP_SECURE=false
```

### Per-club override (alternative to env-wide config)

Instead of `.env.local`, you can set provider creds per-club via the
admin Integrations page (`/app/admin/integrations`). Pick scope
`EMAIL`, provider `smtp`, and put `host` / `port` / `fromAddress` /
`user` / `secure` in the config JSON and `pass` in the secrets JSON.
Per-club rows win over env-driven mode (except when the seeded
placeholder rows have `provider="dev"` / `"local"` — those are treated
as "no real provider configured" and the env mode takes over).

The admin Integrations page also has a "Send test email" form that
posts through the configured adapter, so you can confirm a provider
works from the UI without dropping to the CLI.

## Avoiding console mode in production

If the success screen ever shows "Receipt generated in the development email
log", real delivery is NOT happening. To fix:

- Ensure `EMAIL_DELIVERY_MODE` is set to `smtp` or `ses` in the running
  process's environment, OR
- Replace the per-club `IntegrationSetting(scope=EMAIL)` row's provider from
  `dev`/`local` to `smtp`/`ses` with valid config.

The closed-check history page shows the current mode in a banner at the top.

## Verifying real-inbox delivery end-to-end

When you swap from Maildev to a real provider:

1. Stop Maildev (Ctrl-C the `npm run mail:dev` shell). Keep it stopped — it
   isn't needed for real delivery.
2. Edit `.env.local` with the provider block from above.
3. Restart `npm run dev` so the new env is picked up.
4. Smoke-test the relay first:
   ```
   npm run email:test-real -- you@yourinbox.com
   ```
   Output classifies the target as `EXTERNAL SMTP relay` and only exits
   0 if `transporter.verify()` AND the send both succeed.
5. Run the POS flow:
   - Set Owen Beauchamp's profile email to your real address.
   - Open `/app/admin/ops/pos/lounge`, add items, settle to Charge to
     Member Account.
   - The success card reads "Receipt emailed to y***@gmail.com"; the
     closed-check history banner reads *"SMTP (external relay) — receipts
     deliver via the configured SMTP server"*.
   - Repeat with Pay-by-Phone → confirm → email arrives only after the
     payment is confirmed.

## Distinguishing local vs external delivery

The system surfaces the delivery target in three places:

- **CLI script** (`npm run email:test-real`) — prints
  `Target: LOCAL inbox (Maildev/Mailhog)` or `Target: EXTERNAL SMTP relay`
  near the top. The local case also reminds you that real recipients
  are not receiving anything.
- **Closed-check history banner** — green banner reading either *"SMTP
  (local Maildev) — delivered to the local inbox at http://localhost:8025
  only"* or *"SMTP (external relay) — receipts deliver via the configured
  SMTP server"*. Click into a check to see the masked recipient.
- **POS settlement success screen** — the success card always shows the
  recipient. `SENT` + the history banner together tell the operator
  whether that means a real inbox or just Maildev.

## Troubleshooting

- **`smtp reachable FAIL`** — Maildev isn't running, OR your firewall
  is blocking outbound 587/465. Test with `openssl s_client -starttls smtp
  -connect HOST:PORT` (or just `nc -vz HOST PORT`).
- **`transporter.verify()` fails with `Invalid login`** — credentials
  wrong (or Postmark/SendGrid SMTP user/pass swapped — see provider
  recipes above).
- **`SENT` in the DB but no email in inbox** — receipt was accepted by
  the provider but bounced silently. Check the provider's send/bounce
  log. The most common cause is unverified sender domain.
- **`FAILED` with "nodemailer not installed"** — run `npm install`.
- **`FAILED` with "EMAIL_DELIVERY_MODE=smtp but SMTP_HOST/SMTP_PORT/SMTP_FROM
  not set"** — values missing from `.env.local`. Restart the dev
  server after editing.
- **Gmail rejects with `BadCredentials`** — you tried a normal password.
  Gmail requires an app password; see the Gmail recipe above.
- **Maildev shows the email but Owen doesn't get it for real** — by design.
  Maildev never forwards mail anywhere. Use a real SMTP relay (above) for
  production-style testing.
