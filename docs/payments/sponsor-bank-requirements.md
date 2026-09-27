# Spectre — Sponsor / Clearing Institution Requirements

**Version:** 2026-09-26 (PAY-1C/5)
**Audience:** Canadian sponsor bank / clearing institution
originations, product, technology, risk, and compliance teams.
**Purpose:** describe what Spectre is, how it originates payment
instructions, and what capabilities Spectre needs from a financial
partner to move from an accepted internal payments platform to a
real Canadian rail. This is a requirements conversation — Spectre is
not prescribing the institution's solution.

**Not a legal document.** Spectre's Canadian payments counsel is
separately determining the regulatory framework (RPAA, FINTRAC/MSB,
agency characterization). This document describes the technical +
operational requirements only.

---

## 1. Who Spectre is

Spectre is a vertical SaaS platform for Canadian private golf and
country clubs. Customers are individual clubs; each is a separate
tenant with its own accounting records, bank accounts, employees,
vendors and members inside the shared Spectre platform.

Spectre originates two categories of payment instructions today:

- **Payroll** — semi-monthly / bi-weekly / weekly employee net-pay
  distributions from the club's operating bank account to the
  employee's own Canadian bank account.
- **Accounts Payable** — vendor payments (design-in-progress; not
  yet built into a real rail).

Both categories are authorized by the club's own Controller /
Payroll Administrator inside Spectre. Spectre does not initiate
payments on the club's behalf without maker/checker authorization.

## 2. How Spectre originates a payment

1. A payroll run (or AP batch, future) is prepared inside Spectre
   from authoritative source data (approved timesheets, statutory
   deductions, employer contributions).
2. The Controller reviews and authorizes the run. Spectre computes
   a deterministic **payment fingerprint** over the material fields
   (funding account, currency, execution date, per-instruction
   fingerprints). Any material change after authorization
   invalidates it.
3. Instructions are immutable from authorization onward. Each
   instruction carries an **end-to-end identifier** (`E2E-v1-…`)
   that is stable across retries and rail representations.
4. On execution, Spectre submits each instruction to the payment
   provider adapter. The adapter is the ONLY place credentials
   touch Spectre — via opaque KMS references.
5. Every provider callback is verified before Spectre allows a
   financial-state mutation. Amount / currency / reference /
   tenant mismatches fail closed.

Detailed technical mapping: `canonical-rail-mapping.md`.

## 3. What Spectre needs the sponsor institution to do

### 3.1 Custody

**Customer funds remain in the customer's own bank account until the
agreed payment mechanism debits that account for the agreed
transaction.** Spectre does not want to receive or hold customer
funds.

- Please confirm your proposed structure preserves this model.
- If your structure requires pooled client accounts, prefunding, or
  reserves, we need to understand the mechanics and the impact on
  Canadian regulatory characterization.

### 3.2 Authorization model

**Critical product requirement.** Can Spectre submit a payment
instruction under the customer's delegated authority such that the
customer's authorized action inside Spectre is sufficient for
execution — without the customer separately logging into your portal
and manually re-approving the same payment?

If not, please describe the alternative flow and the technical
authority Spectre would need to obtain from each customer club at
onboarding.

### 3.3 Multi-tenant / multi-originator

Spectre cannot reasonably establish a bespoke integration for every
club. Please describe:

- how you support multiple underlying business customers under a
  single Spectre integration;
- customer-specific funding accounts;
- delegated technical credentials (per-customer vs. per-Spectre);
- originator identification;
- per-customer limits;
- customer onboarding / offboarding.

### 3.4 Payment initiation capabilities

Please confirm whether you support:

- machine-to-machine initiation of Canadian credit payments;
- AFT credit origination (payroll + vendor payments);
- scheduled execution;
- payments to any Canadian destination institution;
- future RTR participation / connectivity.

### 3.5 Message + batch semantics

Please describe:

- your submission unit (batch vs. per-payment);
- per-payment identifiers you require or return;
- per-batch identifiers;
- how you signal acknowledgement (file / record level);
- how you signal per-record rejection;
- status reporting (frequency, mechanism);
- return handling;
- reconciliation reporting (settlement + returns).

### 3.6 Connectivity

Please describe supported options:

- API;
- host-to-host;
- SFTP / MFT;
- ISO 20022 (pain.001, pain.002, camt.053, camt.054);
- proprietary file formats;
- webhook / callback + polling / status file;
- certificates + mTLS;
- IP allowlisting;
- signing / encryption;
- credential rotation.

### 3.7 Operations

Please describe:

- submission cutoffs (daily / by rail);
- settlement timing;
- holiday / weekend handling;
- cancellation windows;
- recall / reversal mechanism (if any);
- return timelines and return codes;
- duplicate protection at your end + idempotency mechanism;
- outage handling + business continuity;
- incident escalation contacts + SLAs.

### 3.8 Risk + financial

Please describe:

- per-transaction / daily / exposure limits;
- prefunding / reserves / collateral / settlement-agent structure;
- credit underwriting requirements;
- liability allocation for: fraud, unauthorized payment,
  return-of-funds, insufficient-funds, mis-directed payments;
- your dispute-resolution mechanism.

### 3.9 Onboarding

For Spectre:

- corporate documentation;
- financial statements;
- security documentation (SOC 2, pen-test reports, business
  continuity, incident response);
- compliance status (RPAA registration, MSB status, insurance);
- Canadian counsel of record.

For each club:

- KYB requirements;
- bank account validation mechanism;
- signing authority verification;
- payment-authorization mechanism;
- limits;
- beneficial ownership;
- your standard agreements + how Spectre presents them to clubs.

## 4. What Spectre commits to

- Spectre does not hold customer funds.
- Spectre does not modify authorized payments in place. Every
  material change invalidates authorization and requires
  re-authorization.
- Spectre does not create duplicate economic payments on retry.
  The economic identity of a payment is stable across retries and
  transport representations.
- Spectre verifies every provider callback signature before
  allowing a financial mutation.
- Spectre never persists plaintext credentials — only opaque KMS
  references.
- Spectre preserves complete audit evidence: PaymentInstruction,
  PaymentAuthorization, PaymentEvent, ExternalPaymentEvent,
  PaymentIncident, and AuditLog records are append-only.
- Spectre supports operational containment through connection
  suspension + kill switches; containment never deletes a payment.
- Spectre supports maker/checker separation via distinct
  permissions.
- Every Spectre-sourced instruction carries a deterministic
  end-to-end ID for downstream correlation.

## 5. Non-negotiables (from Spectre)

- No modification of an authorized payment in place.
- No pooled client account structure where Spectre would take
  custody of customer funds.
- No customer requirement to re-approve every payment inside the
  bank's portal after already approving it inside Spectre.
- No mechanism that creates a second economic payment on retry.

## 6. Open regulatory questions

Answers to these are pending Canadian payments counsel. Spectre
does not seek institutional advice on them; we note them so the
institution understands the parallel workstream:

- RPAA registration determination.
- FINTRAC / MSB determination.
- Agency / mandatary characterization between Spectre and each
  club.
- Bank-Spectre contractual structure.

## 7. What Spectre is asking for

An initial technical + risk conversation, culminating in:

1. A written response to §3 questions above.
2. Access to your sandbox specification (if available).
3. A path to onboarding for a small number of pilot clubs under a
   scoped commercial + regulatory agreement.

Contact: c.s.turcato@gmail.com.
