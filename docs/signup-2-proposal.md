# SIGNUP-2 -- Scope + Implementation Proposal

**Status.** Planning only.  No code; no live payment entities; no
tenant activation.

**Audience.** Founder review before any implementation begins.

**Dependencies accepted at this point:**
- SIGNUP-1G accepted on staging (dedicated transactional-mail Entra
  app + Exchange RBAC + 30-min recovery TTL + regression evidence).
- Classifier (`src/lib/signup/org-verification.ts`) continues to
  emit `AUTOMATED_PASSED | NEEDS_MANUAL_REVIEW | ESCALATED |
  OVERRIDDEN` as the preliminary risk signal.
- Spectre's existing dormant Stripe adapter at
  [src/lib/billing/index.ts](../src/lib/billing/index.ts) (card
  path) is NOT the primary SIGNUP-2 instrument; see Section 3.
- The delegated-authority commercial-authority model in
  [docs/signup-2-commercial-authority-verification.md](signup-2-commercial-authority-verification.md).
- The Stripe ACSS-Debit architecture note in
  [docs/signup-2-payment-architecture.md](signup-2-payment-architecture.md).

Both prior docs stay in force.  This document extends them into an
executable plan.

---

## 1 Commercial posture

- **Annual subscription:** CAD $38,000 per Club.
- **Primary instrument:** Stripe ACSS Debit (Canadian Pre-Authorized
  Debit via Payments Canada ACSS; CPA Rule H1 governs).  Card remains
  a secondary option a Controller can elect.
- **Payment experience:** Spectre-controlled UI (Stripe
  Checkout `mode: "setup"` hosted mandate collection is used only
  for the one page that collects PAD bank details + mandate
  acceptance -- everything else is a Spectre-branded screen).  No
  AP-workflow dependency, no third-party invoicing experience, no
  "Pay a Stripe invoice link" email.
- **Three distinct lifecycle events** (never merged):

  1. **Subscription authorisation.**  Signatory accepts the
     mandate + attestation.  Spectre records who / when / what
     signed.  **No funds move.**
  2. **First debit (payment collection).**  Stripe initiates the
     PAD via the collected mandate.  Settles T+4 to T+5 on
     standard timing.
  3. **Tenant activation.**  Spectre provisions the Club tenant
     (User + Club + UserClubRole + initial seed data).

  Timing: 1 happens at signup completion; 2 fires immediately after
  on Spectre's trigger (not Stripe's); 3 fires on
  `payment_intent.succeeded`.  The three events are independent;
  the lifecycle supports retry + rollback + manual override.

---

## 2 Customer journey + UI states

Expressed as `SignupRegistration.step` extensions on top of the
accepted SIGNUP-1 lifecycle.  Each row describes a single state
and the UI the applicant sees.

| Step (new) | Precondition | Spectre UI | Operator state |
|---|---|---|---|
| `ADMIN_VERIFIED` (existing) | Microsoft identity captured; position selected; classifier run | SIGNUP-1 status card: "Your registration is saved" | Idle; await signatory decision |
| `AUTHORITY_PENDING` | Classifier green OR exception artefact uploaded + reviewer-released | Signatory-attestation surface: "Confirm you have authority to bind this Club" | Idle; await attestation |
| `MANDATE_PENDING` | Attestation accepted | Stripe-hosted Checkout page in setup mode: collect bank account + mandate acceptance | Awaiting SetupIntent.succeeded |
| `MANDATE_CAPTURED` | SetupIntent.succeeded webhook | Spectre summary page: "Mandate accepted; first debit in <N> business days" | Spectre creates Subscription + first invoice |
| `AWAITING_FIRST_SETTLEMENT` | PaymentIntent.processing webhook | Status card: "First payment in flight" with ETA | Idle; await settlement |
| `ACTIVE` | PaymentIntent.succeeded webhook | Spectre tenant activated; redirect to the newly-provisioned Club dashboard | Audit; monitor |
| `AT_RISK` | PaymentIntent.payment_failed OR charge.dispute.created | Status card: "Payment issue; Spectre will contact you" + operator notified | Operator reaches out |
| `CANCELLED` | Subscription cancellation | Static page: "Subscription cancelled; data retained per policy" | Audit; schedule teardown per policy |
| `MANUAL_INVOICE` | Operator elected fallback (edge case) | Status card: "Invoice to follow; Spectre will contact you" | Operator-driven; no Stripe entity |

Each state transition emits an audit record (`audit()` call per
Spectre's standard pattern).  Each transition has a defined
inverse for rollback where the real world allows it (e.g.
MANDATE_CAPTURED -> MANDATE_PENDING on operator revocation).

### 2a Non-standard transitions (deliberate design)

- **MANDATE_CAPTURED without AWAITING_FIRST_SETTLEMENT.**  If
  Spectre's internal operator wants to defer the first debit (e.g.
  pending final paperwork), the lifecycle allows holding at
  MANDATE_CAPTURED until an operator-triggered "charge now" action.
- **ACTIVE without debit (manual-invoice path).**  If a Club pays
  by wire or cheque, the operator can mark `ClubSubscription.status =
  ACTIVE` + `source = MANUAL_INVOICE` without any Stripe entity.
  This is the rare-case fallback; it's covered to prevent "we
  can't support this Club at all" lock-in.
- **Tenant provisioning never fires before first-settlement
  succeeded unless `source = MANUAL_INVOICE` AND operator confirmed
  cleared funds.**  Hard invariant.  Covered by RBAC + audit.

---

## 3 Payment-provider architecture options

The 2026-10-20 payment architecture doc (link in dependencies)
recommends Stripe ACSS Debit on the strength of Spectre's existing
Stripe wiring + Stripe's mandate / dispute tooling.  That
recommendation stands.  This section calls out the specific
Stripe-adjacent choices SIGNUP-2 must make at kickoff + the
alternatives considered.

### 3a Primary -- Stripe ACSS Debit (recommended)

- Stripe-hosted Checkout in `mode: "setup"` for mandate collection
  (Section 4 of the architecture doc).
- Subscriptions API for recurring annual billing against the
  saved PaymentMethod with `default_for: ['invoice', 'subscription']`.
- Fees: CAD $0.68 flat + 1% per PAD transaction.  (At $38K annual:
  ~CAD $380.68 per cycle.)
- Settlement: T+4 success / T+5 funds available.
- Mandate text + mandate-confirmation email + debit-notification
  email all handled by Stripe to satisfy Rule H1.
- Spectre persists mandate acceptance context in
  `SubscriptionPaymentMandate` (new model; see Section 5a).

**Open decision #1 for founder approval:**
*Default to annual billing (one $38K debit per year) OR offer
quarterly instalments ($9,500 x 4)?*  Annual is simpler + default
in the architecture doc; quarterly reduces NSF exposure but
quadruples Stripe fees.  Recommend annual as default.

### 3b Secondary -- Commercial card (card_present / Checkout card mode)

Supported by Spectre's existing adapter without changes.  Elected
by the Controller on a per-Club basis via a toggle on the
signatory-attestation page.  Default is PAD; card is opt-in.

- Fees: 2.9% + CAD $0.30.  At $38K annual: ~CAD $1,102.
- Settlement: T+2.
- Chargeback window: 120 days (vs 10 bd for business PAD).
- Issuer-side authorisation limits may apply at $38K (common
  commercial cards cap single transactions at $25K-$50K).
- Mitigation: split annual charge into 4 quarterly debits at
  $9,500 per quarter.  Operator-elected per Club.

### 3c Tertiary -- Manual invoice (wire / cheque / EFT via bank portal)

Fallback for Clubs whose bank doesn't support PAD or whose
Controller cannot elect card.  Spectre operator records cleared
funds; tenant activates on operator sign-off.

Not an automated path; by design.

### 3d Rejected alternatives (documented for completeness)

- **Rotessa / Plooto / Interac eTransfer:** smaller fee stack but
  immature dispute / mandate tooling vs Stripe.  Rejected unless
  the Stripe fee stack starts hurting at larger Club counts; the
  adapter interface at [src/lib/billing/index.ts](../src/lib/billing/index.ts)
  makes a later swap tractable.
- **Spectre-built direct ACH integration with a Canadian bank:**
  high regulatory burden, poor fit for Spectre's early-stage scale.

**Open decision #2:**
*Launch SIGNUP-2 with ACSS Debit primary + card secondary, OR
ACSS Debit only?*  Recommend "primary + secondary" so the
Controller is never blocked by issuer-side card limits.

---

## 4 Required approvals + mandates

Captured at distinct points in the SIGNUP-2 flow:

### 4a Commercial-authority attestation (text SHA-256 recorded)

Per [docs/signup-2-commercial-authority-verification.md](signup-2-commercial-authority-verification.md):

- Attestation text displayed in-page; signatory clicks "I confirm".
- `SubscriptionAuthorisationAttestation` row records: signatory
  identity (Microsoft `oid` + `tid`), timestamp, IP, user agent,
  attestation-text SHA-256, display name, title, Club legal name.
- Immutable thereafter.

### 4b CPA Rule H1 PAD mandate (Stripe-hosted; Stripe-stored)

- Stripe presents mandate text that satisfies Rule H1 Section 19
  (payor name, payee = Spectre Automation, payor bank, debit
  amount or variable-amount cap, frequency, authorisation date,
  cancellation rights).
- Signatory enters institution + transit + account; verifies
  (instant OR microdeposit).
- Signatory clicks "Accept".
- Stripe generates mandate id + sends mandate-confirmation email
  (within 5 calendar days per Rule H1).
- Spectre persists `SubscriptionPaymentMandate` row.

### 4c Debit notification (Stripe-sent, Rule H1 Section 20)

- On every debit, Stripe emits `charge.pending` + sends debit-
  notification email to the payor.
- Spectre's webhook handler marks `BillingCycle.status =
  AWAITING_SETTLEMENT`; does NOT also send its own notification
  (would duplicate Stripe's).

### 4d Cancellation (Rule H1 Section 21)

- Payor can cancel the mandate at any time via a Spectre operator
  request OR directly with their bank.
- Cancellation revokes the Stripe PaymentMethod + logs a
  `SubscriptionPaymentMandate.revokedAt` row (does NOT delete
  the original; audit retention is a hard invariant).
- Future debits refuse.

---

## 5 Data model (planned)

Three new models + modest extensions.  Final shapes land during
implementation after review.

### 5a `SubscriptionPaymentMandate`

```prisma
model SubscriptionPaymentMandate {
  id                       String   @id @default(cuid())
  clubId                   String
  club                     Club     @relation(fields: [clubId], references: [id])
  signupRegistrationId     String?  // tenant provision mirrors it over
  stripePaymentMethodId    String   @unique
  stripeMandateId          String   @unique
  mandateType              String   // "ACSS_DEBIT" | "CARD"
  mandateVariant           String   // "INTERVAL" | "SPORADIC" | "COMBINED"
  transactionType          String   // "BUSINESS"
  acceptedAt               DateTime
  acceptedByUserId         String?
  acceptedByMicrosoftOid   String?
  acceptedIp               String?
  acceptedUserAgent        String?
  mandateTextHash          String   // SHA-256 of Stripe-rendered text at acceptance
  mandateTextLength        Int
  revokedAt                DateTime?
  revokeReason             String?

  @@index([clubId, acceptedAt])
}
```

### 5b `SubscriptionAuthorisationAttestation`

```prisma
model SubscriptionAuthorisationAttestation {
  id                       String   @id @default(cuid())
  signupRegistrationId     String   @unique
  clubId                   String?  // null until tenant provisioned; backfilled
  signatoryFullName        String
  signatoryTitle           String
  clubLegalName            String
  attestationTextHash      String   // SHA-256 of the exact text at acceptance
  acceptedAt               DateTime
  acceptedIp               String?
  acceptedUserAgent        String?
  acceptedByMicrosoftOid   String?
  acceptedByMicrosoftTid   String?
}
```

Immutable; append-only.

### 5c `EntityStandingCheck`

Replaces the earlier draft's `CorporateRecordsCheck` to make the
soft-signal nature explicit.  Captures registry lookup payload +
standing (`ACTIVE | NOT_ACTIVE | NOT_FOUND`).  Signatory-vs-officer
match is a recorded signal, never a hard gate for baseline
registrations (per the delegated-authority model).

### 5d Extensions to `ClubSubscription`

- `status` enum widened to include every state from the lifecycle
  map in Section 2 (`PENDING_AUTHORITY | AUTHORITY_ACCEPTED |
  MANDATE_PENDING | MANDATE_CAPTURED | AWAITING_FIRST_SETTLEMENT |
  ACTIVE | AT_RISK | CANCELLED | MANUAL_INVOICE`).
- `source` enum: `STRIPE_ACSS | STRIPE_CARD | MANUAL_INVOICE`.
- `firstSettlementAt` + `nextRenewalAt` columns.
- Existing `activatedAt / cancelledAt` columns retained.

### 5e `BillingCycle` extensions

- `source` column mirrors `ClubSubscription.source`.
- `expectedDebitDate` from Stripe `payment_method_details.acss_debit.expected_debit_date`.
- `settlementConfirmedAt` separately from `createdAt`.

---

## 6 Security + compliance

### 6a Secret handling

- Stripe API key + webhook secret stored as Fly secrets, same
  pattern as the SIGNUP-1G transactional-mail secret (never on
  CLI, in files, in logs, or in chat).
- Rotation runbook: analogous to the SIGNUP-1G transactional-mail
  rotation ([docs/signup-1g-credential-rotation.md](signup-1g-credential-rotation.md)),
  adapted for Stripe's dashboard + the Fly staging activation
  script's secret-import pattern.

### 6b CPA Rule H1 record-keeping

- Spectre retains `SubscriptionPaymentMandate` for 7 years after
  mandate end.
- Stripe retains the mandate text; Spectre retains the acceptance
  context (who / when / IP / UA).

### 6c PIPEDA / provincial privacy

- Signatory personal information in attestation + mandate records
  is handled under Spectre's existing privacy posture.
- Government-ID (elevated-risk path only) is stored encrypted at
  rest (KMS envelope keys), deleted after verification + 90 days.

### 6d FINTRAC

- Spectre is not a reporting entity for subscription revenue.
- No MSB registration implied.

### 6e Idempotency + duplicate-charge protection

Essential invariants for the implementation:

1. **One `PaymentIntent` per `BillingCycle`.**  `BillingCycle.id`
   is passed as Stripe's `idempotency_key` on PaymentIntent create.
   Retries from Spectre produce the same PaymentIntent, not a
   duplicate.
2. **One `BillingCycle` per `(clubId, periodLabel)`.**  Unique
   constraint already exists on the model.
3. **Webhook events deduplicated by Stripe `event.id`.**  Spectre
   persists seen event ids; duplicate webhook deliveries are a
   no-op.
4. **`charge.succeeded` is the ONLY event that transitions
   `BillingCycle` to `PAID`.**  Not `payment_intent.processing`,
   not `payment_intent.succeeded` on a card path, not any
   manual-ops shortcut.  Prevents accidental double-counting.
5. **Tenant provisioning (`User` + `Club` + `UserClubRole` writes)
   runs inside the same DB transaction as the
   `ClubSubscription.status -> ACTIVE` update.**  Prevents the
   paid-but-no-tenant anomaly.

### 6f Failed / incomplete payment handling

- **NSF / returned PAD** -> `payment_intent.payment_failed` ->
  `BillingCycle.status = FAILED`.  Stripe Smart Retries attempts
  once within 30 days (if enabled per account policy).
  Spectre notifies operator; operator contacts Club.
- **Dispute (business account; 10 bd window)** ->
  `charge.dispute.created` -> operator notified; `BillingCycle`
  stays `PAID` but marked `DISPUTED` with the dispute amount.
  Cannot be contested per Stripe; outcome is final.
- **Mandate revoked mid-cycle** -> `SubscriptionPaymentMandate.revokedAt`
  recorded; next renewal blocked; Spectre contacts Club for a
  fresh mandate.

### 6g Reconciliation + audit logging

- Every state transition on `SignupRegistration`,
  `ClubSubscription`, `BillingCycle`,
  `SubscriptionPaymentMandate`, and
  `SubscriptionAuthorisationAttestation` emits an `audit()` call
  with before/after + actor + IP + user agent.
- A nightly reconciliation job compares Spectre's
  `BillingCycle.status` against Stripe's PaymentIntent + Charge
  state for the past 30 days; divergence emits a
  `spectre.billing.reconciliation.drift` audit event.

---

## 7 Failure modes + rollback

| Failure | Detection | Rollback |
|---|---|---|
| SetupIntent creation 500s | Stripe API error on create | User sees error page; `SignupRegistration.step` stays at `AUTHORITY_PENDING`; no partial state; retry allowed. |
| Mandate collection abandoned by user | Checkout session expires | No webhook; `step` stays at `MANDATE_PENDING`; recovery link lets them resume. |
| First debit NSF | `payment_intent.payment_failed` webhook | `BillingCycle.FAILED`; `ClubSubscription.AT_RISK`; operator contacts Club; **tenant NOT provisioned**. |
| Dispute opened post-success | `charge.dispute.created` webhook | `BillingCycle.DISPUTED`; `ClubSubscription.AT_RISK`; operator contacts Club; **tenant NOT torn down** (dispute may be erroneous; Spectre retains data per policy). |
| Signatory revokes mandate between acceptance + first debit | Stripe PaymentMethod.updated webhook | `SubscriptionPaymentMandate.revokedAt`; `ClubSubscription.MANDATE_PENDING`; applicant can submit a new mandate. |
| Webhook delivery lost | Nightly reconciliation detects drift | Audit event emitted; operator triggers manual reconciliation. |
| Spectre fails tenant provisioning after paid cycle | Same DB-transaction invariant means the whole transition rolls back; `BillingCycle` stays `PAID`; `ClubSubscription.status` reverts | Operator retries provisioning; no funds move. |

---

## 8 Staging test strategy

Mirrors SIGNUP-1G's acceptance pattern:

1. **Dedicated Stripe TEST account** for staging; never share Live
   Stripe keys with staging.
2. **Playwright specs:**
   - `signup-2-authority-attestation.staging.spec.ts` -- walk the
     attestation surface; verify immutable record.
   - `signup-2-mandate-capture.staging.spec.ts` -- walk the
     Stripe-hosted mandate collection in test mode; verify
     SetupIntent + PaymentMethod + Mandate persistence.
   - `signup-2-first-debit.staging.spec.ts` -- Stripe test clock
     (`test_clock`) advances to simulate T+4 settlement; verify
     `BillingCycle.PAID` + tenant provisioning + redirect.
   - `signup-2-nsf-retry.staging.spec.ts` -- Stripe test payment
     method `pm_card_chargeDeclinedInsufficientFunds` (or ACSS
     equivalent); verify `AT_RISK` + no tenant provision.
   - `signup-2-dispute.staging.spec.ts` -- Stripe test dispute
     trigger; verify `DISPUTED` + operator notification.
   - `signup-2-webhook-replay.staging.spec.ts` -- replay a
     webhook event; verify idempotent no-op.
   - `signup-2-manual-invoice.staging.spec.ts` -- operator
     elects manual invoice; verify tenant provision gated on
     operator sign-off.
3. **Contract tests:**
   - `signup-2-lifecycle.test.ts` -- state-machine invariants.
   - `signup-2-idempotency.test.ts` -- replayed webhooks + retried
     operations are no-ops.
   - `signup-2-reconciliation.test.ts` -- drift detector logic.
4. **Secret / audit scans:**
   - Reuse the Fly log scan from SIGNUP-1G's Phase D.5.  Zero
     Stripe key leaks, zero mandate text leaks, zero bank account
     number leaks.
5. **Acceptance evidence template** in the shape of
   `docs/signup-1g-acceptance.md`.

---

## 9 Implementation phases (proposed)

Each phase lands via DRH-1 to staging; each has an acceptance gate.
Production remains unauthorised throughout.

### Phase 2A -- Lifecycle schema + state machine

- `ClubSubscription` + `BillingCycle` enum widening.
- New `SubscriptionPaymentMandate`,
  `SubscriptionAuthorisationAttestation`,
  `EntityStandingCheck` models.
- Prisma migration (dual-schema; same pattern as SIGNUP-1F).
- State-machine service + unit tests.
- **No Stripe calls yet.**
- Acceptance: contract tests green; audit coverage asserted.

### Phase 2B -- Attestation surface

- Signatory attestation UI (`/signup/t/<token>/authority`).
- `SubscriptionAuthorisationAttestation` write path + audit.
- Playwright: authority attestation walk.
- Acceptance: attestation record SHA-256 immutable; audit logged.

### Phase 2C -- Entity standing check

- `EntityStandingCheck` + jurisdiction registry adapter (ON, BC
  on day one; QC / AB / smaller provinces via manual review
  initially).
- Soft-signal recording; no gate on signatory-vs-officer match.
- Acceptance: registry lookup round-trips end-to-end for the
  CA registry adapter under test.

### Phase 2D -- Stripe adapter extensions

- Extend `BillingProvider` with
  `createPadMandateSetupSession`,
  `createPadSubscription`,
  `retrieveMandate`,
  `createCardCheckoutSession` (existing),
  `syncSubscriptionStatus`.
- Dynamic-import `stripe` npm package (adapter stays dormant
  until `SPECTRE_BILLING_PROVIDER=stripe`).
- Mock-provider parity for every new method.
- Acceptance: adapter contract tests; mock provider deterministic.

### Phase 2E -- Mandate capture flow

- `/signup/t/<token>/mandate` page launches Stripe Checkout in
  setup mode.
- Return handler reads SetupIntent + persists
  `SubscriptionPaymentMandate`.
- Webhook route handles `checkout.session.completed` +
  `payment_method.updated`.
- Acceptance: mandate persistence + Stripe test-mode walk.

### Phase 2F -- First debit + settlement

- `payment_intent.processing / succeeded / payment_failed`
  webhook branches.
- `BillingCycle` transitions + idempotency key.
- `ClubSubscription.status` transitions.
- Acceptance: Stripe test clock advances; staging walks succeed +
  fail scenarios.

### Phase 2G -- Tenant provisioning

- `User` + `Club` + `UserClubRole` writes inside the same DB
  transaction as `ClubSubscription.ACTIVE`.
- Initial seed data pattern (chart of accounts, roles,
  default settings).
- Welcome email (via SIGNUP-1G transactional-mail adapter).
- Acceptance: paid-cycle -> tenant active + welcome email sent;
  all audit records present.

### Phase 2H -- Operator surface

- SpectreAdmin screens for signatory review, elevated-risk
  artefact upload, manual-invoice workflow, mandate revocation,
  reconciliation drift resolution.
- Permission gated.
- Acceptance: operator screens functional + audit coverage.

### Phase 2I -- Reconciliation + alerting

- Nightly reconciliation job (worker-scheduler cron).
- Audit emission on drift.
- Operator notification channel (TBD -- email, Slack, dashboard).
- Acceptance: induced drift surfaces within 24 h.

### Phase 2J -- Production readiness

- Stripe LIVE account provisioning.
- PAD capability enablement review.
- Fly production secret deployment via the same stdin pattern.
- First real-Club pilot (founder-approved).
- Acceptance: founder authorises production rollout.

---

## 10 Risks + mitigations

| Risk | Mitigation |
|---|---|
| Stripe Checkout subscription mode doesn't support PADs (confirmed in architecture doc) | Use `mode: "setup"` + separate Subscriptions API call (architecture doc Section 3). |
| First-debit NSF on PAD leaves applicant stuck for 2 weeks | Stripe Smart Retries + operator contact; applicant can re-submit mandate at any time. |
| PAD dispute window is 10 bd (business) with no contest path | Monitor dispute rate; if dispute rate > N per 100 cycles, escalate to card-only onboarding for the affected pattern. |
| Signatory authority is incorrect post-authorisation (impersonation) | Attestation records SHA-256 of the exact clicked text + Microsoft `oid`; dispute resolution relies on this record. |
| Fly deploy of Stripe secret duplicates SIGNUP-1G BOM injection failure | Reuse the SIGNUP-1G `scripts/signup-1g-fly-secrets-activate.ps1` pattern; `[Console]::InputEncoding` swap is already proven. |
| Stripe secret rotation drops subscription webhooks | Overlap-rotation per the SIGNUP-1G credential-rotation runbook pattern. |
| Reconciliation drift silently diverges | Nightly job + audit emission; founder-reviewed dashboard. |
| Tenant provisioned but paid cycle not actually settled | DB-transaction invariant + no provisioning fires before
`payment_intent.succeeded`. |
| Manual-invoice path misused | Operator-only + separate audit action name + required operator sign-off text + mandatory operator identity logged. |

---

## 11 Architectural decisions needed from the founder (before coding)

1. **Default billing cadence:** annual single debit (recommended),
   OR quarterly instalments?  See Section 3a.
2. **Launch instrument mix:** ACSS Debit primary + card secondary
   (recommended), OR ACSS Debit only?  See Section 3d.
3. **First-debit timing:** immediately on mandate acceptance
   (recommended; aligns with Stripe default), OR deferred to
   operator trigger?  See Section 2a.
4. **Welcome email surface:** SIGNUP-1G transactional-mail
   adapter (recommended; same no-reply@ identity), OR a new
   dedicated adapter for welcome?  Separate identity has clearer
   audit; shared identity is simpler.
5. **Operator notification channel:** email, Slack, or an
   in-dashboard inbox?  Each has different latency + reliability
   tradeoffs.
6. **Reconciliation window:** 30 days (recommended default),
   7 days (tighter but more false positives from in-flight PADs),
   90 days (looser but easier)?
7. **Pilot Club list for production rollout:** who / how many /
   how early?
8. **Pricing variants:** ever a $38K Club?  Discounts?  Tiers?
   SIGNUP-2 can bake flexibility in now or defer.
9. **Government-ID retention after elevated-risk path:** 90 days
   (recommended), 30 days (minimal), 365 days (regulatory
   defensive)?
10. **Terms of service version pinning:** does the attestation
    include a snapshot of the ToS SHA-256 at acceptance?
    Recommend yes.

Each of these is a product decision, not an engineering question.
No implementation begins until the founder has answered 1-10 (or
confirmed the recommended defaults).

---

## 12 Acceptance criteria for the SIGNUP-2 workstream as a whole

Modelled on SIGNUP-1G's pattern:

- Every phase (2A-2J) lands via DRH-1 to staging.
- Each phase has its own `docs/signup-2-<phase>-acceptance.md`
  with evidence (contract tests + Playwright + log scans +
  audit coverage).
- The final signup-2 acceptance report proves end-to-end:
  signatory attestation -> mandate acceptance -> first debit
  settles -> tenant provisioned -> welcome email delivered via
  the SIGNUP-1G adapter.
- Production rollout is a separate deliberate step with explicit
  founder authorisation.
- SIGNUP-1 + SIGNUP-1F + SIGNUP-1G regression suites remain green
  throughout.

---

## 13 What SIGNUP-2 does NOT touch

- `src/lib/signup/recovery-link.ts` and related SIGNUP-1G code
  paths are frozen per [memory/project_signup_1g_accepted.md](../memory/project_signup_1g_accepted.md).
- The b7f855a6-prefixed delegated OAuth app's purpose, scopes,
  and redirect URIs are unchanged.
- Spectre's existing accounting / GL / AP / AR / payroll modules
  are untouched by this proposal.
- Production tenants are untouched.
- Member-portal + white-label branding is unaffected.

---

## 14 Open items for the founder's response

Please respond with:
- Explicit answers (or "accept recommended default") to Decisions
  1-10 in Section 11.
- Authorisation to begin Phase 2A, OR a request to revise the
  proposal.
- Any additional constraints not captured above.

No implementation begins without this response.
