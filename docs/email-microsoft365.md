# Microsoft 365 / Outlook receipt email integration

This is the **recommended production setup** for clubs that already
have a Microsoft 365 tenant. POS receipt emails (Charge to Member
Account, Pay-by-Phone after confirmation, manual resend) send from the
club's own mailbox — for example `receipts@silverspringsgolfclub.com`
— over Microsoft Graph using an App Registration's OAuth credentials.

No Outlook user password is ever stored.

---

## Why Graph, not SMTP+password?

| | SMTP + AUTH LOGIN | Microsoft Graph (this guide) |
|---|---|---|
| Credential stored | User password | OAuth client secret (rotatable, revocable, scoped) |
| Audit trail | None (looks like a human user) | Per-app audit + sign-in logs in Azure AD |
| MFA / conditional access | Breaks; usually disabled to make it work | Honored — app uses its own identity |
| Scope | Whole mailbox + send-as-user | App-only, restrictable to a single mailbox |
| Microsoft posture | Basic Auth deprecated; tenants turn it off | Supported, recommended |

For these reasons Microsoft has been disabling Basic Auth SMTP for new
tenants since 2022. Graph is the only future-proof option for sending
from a real Microsoft 365 mailbox.

---

## What the club Microsoft 365 admin must do

The whole setup happens in the Azure portal as a Global / Cloud
Application admin. It takes about 5 minutes.

### 1. Create an App Registration

1. Sign in to <https://portal.azure.com> with an account that has
   *Application Administrator* or *Cloud Application Administrator*
   role (a *Global Administrator* also works).
2. Search for **Microsoft Entra ID** (formerly Azure AD).
3. *App registrations* → *New registration*.
4. Name: e.g. `Spectre POS Receipts`.
5. *Supported account types*: **Accounts in this organizational directory only**.
6. *Redirect URI*: leave blank — this is a daemon, not an interactive app.
7. Click **Register**.
8. From the *Overview* page, copy the **Application (client) ID** and the
   **Directory (tenant) ID**.

### 2. Add the Mail.Send application permission

1. In the new app: *API permissions* → *Add a permission* →
   *Microsoft Graph* → **Application permissions** (NOT delegated).
2. Find **Mail.Send** → tick it → *Add permissions*.
3. Click **Grant admin consent for &lt;your tenant&gt;** and confirm.
   The Status column should change to a green check for Mail.Send.

**Do not grant Mail.Read, Mail.ReadWrite, or anything broader.** Spectre
only needs to send.

### 3. Create a client secret

1. *Certificates & secrets* → *Client secrets* → *New client secret*.
2. Description: `Spectre receipts secret 1`. Expiry: pick the
   shortest you can live with (12 or 24 months).
3. **Copy the *Value*** (not the *Secret ID*) immediately — Azure hides
   it as soon as you leave the page.
4. Set a calendar reminder 30 days before the secret expires so you can
   rotate it without an outage. Spectre persists `lastTestStatus`/
   `lastTestedAt` on the integration row but it can't see Azure's expiry.

### 4. (Strongly recommended) Restrict to one mailbox

By default, an app with Mail.Send can send from any mailbox in the
tenant. Lock that down to just the receipts mailbox with an
**Application Access Policy**:

```powershell
# In a PowerShell session connected to Exchange Online
Connect-ExchangeOnline

New-ApplicationAccessPolicy `
  -AppId <CLIENT_ID> `
  -PolicyScopeGroupId receipts@silverspringsgolfclub.com `
  -AccessRight RestrictAccess `
  -Description "Spectre POS receipts — restrict to receipts mailbox"
```

Verify with:

```powershell
Test-ApplicationAccessPolicy -Identity receipts@silverspringsgolfclub.com -AppId <CLIENT_ID>
# AccessCheckResult : Granted

Test-ApplicationAccessPolicy -Identity ceo@silverspringsgolfclub.com -AppId <CLIENT_ID>
# AccessCheckResult : Denied
```

Without this policy a compromised Spectre client secret could send mail
as **any** user in the tenant. With it, the blast radius is one
mailbox.

### 5. Make sure the mailbox exists

`receipts@silverspringsgolfclub.com` (or whatever address you choose)
must be a real, licensed Exchange Online mailbox. Common options:

- A licensed user account (e.g. an unattended service mailbox).
- A *Shared Mailbox* — recommended; no license required for sending if
  the volume is reasonable.

It cannot be a distribution list or a Microsoft 365 group.

---

## What to enter in Spectre

Two options. Pick one.

### A. Env-driven (single-tenant deploy, all clubs share one mailbox)

Add to `.env.local` (or your production secret store), then restart:

```
EMAIL_DELIVERY_MODE=microsoft365
MICROSOFT_TENANT_ID=<from step 1>
MICROSOFT_CLIENT_ID=<from step 1>
MICROSOFT_CLIENT_SECRET=<from step 3>
MICROSOFT_FROM_MAILBOX=receipts@silverspringsgolfclub.com
```

### B. Per-club override (multi-tenant SaaS — each club has its own M365 tenant)

Use the admin Integrations page at `/app/admin/integrations`:

- Scope: `EMAIL`
- Provider: `microsoft365`
- Config JSON:
  ```json
  {
    "tenantId": "...",
    "clientId": "...",
    "fromMailbox": "receipts@silverspringsgolfclub.com"
  }
  ```
- Secrets JSON:
  ```json
  { "clientSecret": "..." }
  ```

Secrets are persisted via the platform's secret store (KMS-backed when
configured). The UI never re-displays the saved secret value after save.
A per-club row takes precedence over the env-wide config — so each
club's receipts go from each club's own mailbox.

---

## Verify it works

1. **From the CLI:**
   ```
   npm run email:test-microsoft365 -- you@yourinbox.com
   ```
   The script acquires a token, prints the provider response, and only
   exits 0 if Graph accepted the message. It never prints the client
   secret.

2. **From the admin UI:** open `/app/admin/integrations` →
   the "Email delivery" card shows
   `Active mode: Microsoft 365 → receipts@silverspringsgolfclub.com`.
   Use the "Send test email to" form to fire a real send. The result
   banner reports `SENT` (real delivery) or `FAILED` with the
   provider's error message.

3. **End-to-end POS flow:** open `/app/admin/ops/pos/lounge`, find a
   member with a real email on their profile, add items, settle by
   Charge to Member Account. The success card reads *"Receipt emailed to
   c***@gmail.com"* and the closed-check history banner reads *"Microsoft
   365 — receipts sent from receipts@silverspringsgolfclub.com"*. Repeat
   with Pay-by-Phone → confirm; the receipt sends only after the
   payment is confirmed.

---

## POS receipt behaviour

Once Microsoft 365 is configured, the POS workflow is unchanged from
the operator's perspective:

| Scenario | What happens |
|---|---|
| Charge to Member Account | Settle → AR/GL post → Graph sendMail → success screen shows "Receipt emailed to c***@gmail.com from receipts@silverspringsgolfclub.com" |
| Pay by Phone, pending | No email |
| Pay by Phone, **CONFIRMED** | Same flow as Member Account |
| Pay by Phone, DECLINED / EXPIRED | No email; check returns to active list |
| Graph send fails (token rejected, mailbox not found, etc.) | Settlement still completes; check shows `receiptEmailStatus=FAILED` with the Graph error message in closed-check history. Resend after fixing config. |

---

## Common errors

| Symptom | Likely cause |
|---|---|
| `AADSTS700016: Application with identifier 'X' was not found in the directory` | Wrong `MICROSOFT_TENANT_ID` for this `MICROSOFT_CLIENT_ID`. |
| `AADSTS7000215: Invalid client secret provided` | Secret was rotated or copied incorrectly. Recheck the *Value* (not the *Secret ID*) from Azure. |
| `AADSTS7000222: The provided client secret keys are expired` | Time to rotate. Create a new secret, update Spectre, then delete the old one. |
| `AADSTS65001: The user or administrator has not consented to use the application` | Mail.Send permission was added but admin consent wasn't granted. Click *Grant admin consent* in *API permissions*. |
| `ErrorAccessDenied: Access is denied. Check credentials and try again.` | An Application Access Policy is blocking the mailbox, OR `MICROSOFT_FROM_MAILBOX` doesn't match a real licensed mailbox. Run `Test-ApplicationAccessPolicy` to confirm. |
| `ErrorMailRecipientNotFound: The Recipient '...' is not found.` | `MICROSOFT_FROM_MAILBOX` UPN is wrong. It must be the exact UPN (user-principal-name), not a friendly alias. |
| Conditional Access blocks sign-in | Spectre uses the app's own identity, not a user — conditional access policies that require MFA on user accounts don't apply, but policies on "Other Cloud Apps" can. Exclude this app or scope CA to interactive users only. |
| `transporter.verify()` (from the SMTP test script) doesn't apply | Graph doesn't use SMTP. Use `npm run email:test-microsoft365` instead. |

---

## Security note

The client secret is the credential that lets Spectre send as the
configured mailbox. Treat it like a password:

- **Storage:** put it in `.env.local` for local dev only. For production,
  use your platform's secret store (AWS Secrets Manager, GCP Secret
  Manager, Azure Key Vault, etc.) and reference it through your
  deployment's environment-injection mechanism. Spectre's
  `IntegrationSetting.secretsJson` column is also acceptable — values
  there are stored alongside the per-club configuration.
- **Rotation:** create a new Azure client secret, deploy the new value,
  then delete the old one. Azure allows two valid secrets per app
  registration, so rotation is zero-downtime.
- **Exposure:** Spectre never logs the client secret. The admin UI
  never re-displays it after save. The diagnostic script (`npm run
  email:test-microsoft365`) only reads it from env, never prints it.
- **Scope:** combined with the Application Access Policy from step 4,
  the worst-case impact of a leaked secret is "an attacker can send
  mail as receipts@..." — not "an attacker can send as your CEO."

---

## Multi-tenant / cross-tenant safety

Spectre is multi-tenant. Each club's `IntegrationSetting(scope=EMAIL)`
row is scoped by `clubId`; `selectEmailAdapter(clubId)` will only ever
fetch the calling club's row. There is no path where club A's POS
receipt routes through club B's Microsoft tenant — the receipt service
resolves the adapter by the sale's `clubId`, which itself is tenant-
guarded at every read.
